import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, HAIKU } from "@/lib/claude";
import { profileToValues, mergeDocumentFields, type ProfileValues } from "@/lib/formFill";
import {
  PLANNER_SYSTEM,
  buildPlannerUserMessage,
  validatePlan,
  type PageSnapshot,
} from "@/lib/autofill/plan";
import type { Profile } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// AI portal autofill — the planner. The in-app side panel sends a SNAPSHOT of
// the current external-portal page; we reason over it with the user's
// non-sensitive profile and return a validated, safe list of next actions.
//
// The brain + safety enforcement live in lib/autofill/plan.ts (pure, tested).
// This route only does auth, builds the profile value bag, calls the model, and
// validates. It never fills sensitive fields and never submits an application.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const MAX_ASKED = 40;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { snapshot?: unknown; asked?: unknown; answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const snapshot = body.snapshot as PageSnapshot | undefined;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.fields)) {
    return NextResponse.json({ error: "Missing page snapshot." }, { status: 400 });
  }
  const askedKeys = Array.isArray(body.asked)
    ? (body.asked as unknown[]).filter((x): x is string => typeof x === "string").slice(0, MAX_ASKED)
    : [];

  // Build the non-sensitive value bag: profile + the most recent uploaded
  // document's extracted (non-sensitive) fields + any answers the user has given
  // the agent so far this session.
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  let values: ProfileValues = profileToValues((profile ?? undefined) as Profile | undefined);

  // Merge the non-sensitive fields from EVERY uploaded document, newest first,
  // so the agent uses everything it has read across all of the user's documents.
  // Priority: saved profile > newest document > older documents (mergeDocument-
  // Fields only fills fields still empty).
  const { data: docs } = await supabase
    .from("documents")
    .select("extracted_fields, uploaded_at")
    .eq("user_id", user.id)
    .order("uploaded_at", { ascending: false });
  for (const d of docs ?? []) {
    values = mergeDocumentFields(values, d.extracted_fields as Record<string, string> | null | undefined);
  }

  // Answers the user typed into the agent's "missing info" prompts. Known
  // profile keys are merged into the value bag; everything else is passed to the
  // planner as extra facts it may use to fill the matching field.
  const answers: Record<string, string> = {};
  if (body.answers && typeof body.answers === "object") {
    for (const [k, v] of Object.entries(body.answers as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) {
        const val = v.trim().slice(0, 120);
        answers[k.slice(0, 60)] = val;
        if (k in values && !(values as Record<string, string>)[k]) {
          (values as Record<string, string>)[k] = val;
        }
      }
    }
  }

  const claude = getClaudeClient();
  let rawText = "";
  try {
    const response = await claude.messages.create({
      model: HAIKU,
      max_tokens: 1500,
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: buildPlannerUserMessage(snapshot, values, askedKeys, answers) }],
    });
    const first = response.content[0];
    rawText = first && first.type === "text" ? first.text : "";
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "We're a little busy. Please wait a moment and try again." }, { status: 429 });
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json({ error: "The assistant is temporarily unavailable." }, { status: 502 });
    }
    return NextResponse.json({ error: "Something went wrong planning the next step." }, { status: 500 });
  }

  const plan = validatePlan(rawText, snapshot);
  return NextResponse.json({ ok: true, plan });
}
