import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, SONNET } from "@/lib/claude";

// ─────────────────────────────────────────────────────────────────────────────
// Form Assistant chat — answers form/benefit questions for THIS specific user.
//
// The client sends a privacy-scrubbed context payload (profile summary + the
// non-sensitive extracted_fields from the user's uploaded documents) with every
// request. We weave that into the Claude prompt so answers are tailored ("for
// your refugee status and your arrival date of …") instead of generic.
//
// Safety, unchanged from the rest of the app:
//   • The OUTPUT is scrubbed — we never echo SSN / A-Number / passport / bank
//     numbers even if a stray number slips into the model reply.
//   • Coach, don't autofill: for sensitive fields we tell the user to enter them
//     themselves on the official site rather than producing a value.
//   • Typed error handling: 429 rate limit, 503 auth/permission, 502 empty/upstream,
//     400 bad body.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

// Hard cap on inbound text so a malicious/oversized payload can't blow the prompt.
const MAX_QUERY = 4_000;
const MAX_CONTEXT = 24_000;

// Patterns we redact from the model OUTPUT before returning it to the browser.
// Defense-in-depth: the prompt already forbids these, this guarantees it.
const SCRUBBERS: Array<[RegExp, string]> = [
  // SSN: 123-45-6789 or 123 45 6789
  [/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, "[REDACTED]"],
  // A-Number / Alien Registration: A12345678, A-123 456 789
  [/\bA[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{2,3}\b/gi, "[REDACTED]"],
  // Long bare digit runs (bank/passport/card-like) — 9+ consecutive digits
  [/\b\d{9,}\b/g, "[REDACTED]"],
  // Card-style groups: 1234 5678 9012 3456
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED]"],
];

function scrub(text: string): string {
  let out = text;
  for (const [re, repl] of SCRUBBERS) out = out.replace(re, repl);
  return out;
}

const SYSTEM = `You are the Wayfinder Form Assistant — a calm, plain-language guide that helps refugees and asylees in the United States understand and fill out government benefit and immigration-related forms.

You are given a CONTEXT block describing THIS specific user (their saved onboarding profile and the non-sensitive fields read from documents they uploaded). USE IT. Tailor every answer to their situation — reference their immigration status, key dates, household, and location where relevant (e.g. "For your refugee status and your arrival date of …"). Never give generic boilerplate when the context lets you be specific.

Hard rules:
- COACH, DO NOT AUTOFILL sensitive fields. Never produce, guess, or invent a Social Security Number, A-Number / Alien Registration Number, USCIS number, passport number, or any bank/financial/card number. If a form asks for one, tell the user to enter it themselves directly on the official site, and where to find it on their own document.
- Never echo or repeat any such number even if it appears in the context — it will not, because the context is already scrubbed, but do not reconstruct one.
- You are not a lawyer. For anything involving asylum, removal/deportation, status changes, or other legal matters, tell the user to work with a licensed attorney or DOJ-accredited representative before filing.
- Be concise, warm, and concrete. Use short paragraphs or bullet points. Point to the specific form/section the user is asking about.
- If the context lacks something you'd need to answer fully, say what's missing and how the user can find it — don't fabricate.
- Answer in the requested language when one is provided.`;

interface FormAssistBody {
  query?: unknown;
  language?: unknown;
  context?: unknown;
}

export async function POST(req: NextRequest) {
  // Auth — same gate as the other routes.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse + validate the body. Malformed → 400.
  let body: FormAssistBody;
  try {
    body = (await req.json()) as FormAssistBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { error: "Please type a question first." },
      { status: 400 }
    );
  }

  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim().slice(0, 32)
      : "en";

  // Context is a free-form privacy-scrubbed summary string assembled by the
  // client. We also scrub it server-side as defense-in-depth before it reaches
  // the model, and cap its size.
  const rawContext = typeof body.context === "string" ? body.context : "";
  const context = scrub(rawContext).slice(0, MAX_CONTEXT);

  const userMessage = [
    "CONTEXT — this is the person you are answering for. It is already privacy-scrubbed; sensitive numbers are absent by design.",
    "<context>",
    context || "(no saved profile or document fields were provided)",
    "</context>",
    "",
    `Please answer in language code: ${language}.`,
    "",
    "The user's question:",
    query.slice(0, MAX_QUERY),
  ].join("\n");

  const claude = getClaudeClient();

  let rawText = "";
  try {
    const response = await claude.messages.create({
      model: SONNET,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }],
    });
    const first = response.content[0];
    rawText = first && first.type === "text" ? first.text : "";
  } catch (error) {
    // Typed error handling — most specific first.
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        {
          error:
            "We're a little busy right now. Please wait a moment and try again.",
        },
        { status: 429 }
      );
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return NextResponse.json(
        {
          error:
            "The assistant is temporarily unavailable. Please try again later.",
        },
        { status: 503 }
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: "We couldn't get an answer right now. Please try again." },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const answer = scrub(rawText).trim();
  if (!answer) {
    // Empty/unparseable upstream reply.
    return NextResponse.json(
      { error: "We couldn't get an answer right now. Please try again." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, answer });
}
