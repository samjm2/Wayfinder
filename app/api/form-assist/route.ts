import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, HAIKU } from "@/lib/claude";

// Concrete numeric formats we redact post-hoc as a non-destructive safety net.
// These carry the global flag so EVERY occurrence is scrubbed, and they only
// match actual sensitive number formats — never benign instructional label words.
const SENSITIVE_NUMBER_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN format
  /\b\d{9,16}\b/g, // long digit runs: bank account / routing / card numbers
];

// Field names referenced ONLY in the prompt so the model marks them [YOU FILL IN].
// (No longer used for blanket text replacement — that corrupted legitimate guidance.)
const SENSITIVE_FIELDS = [
  "Social Security Number (SSN)",
  "A-Number / Alien Registration Number",
  "Passport Number",
  "Bank Account Number",
  "Routing Number",
  "Credit Card Number",
];

// ── Context payload (presentation-only summary sent from the client) ──────────
// The chatbot answers for THIS user. We accept a compact, already-scrubbed
// profile summary and a list of document field NAMES (never values). We do a
// second scrub here so a sensitive value can never reach Claude even if the
// client mis-sends one.
interface ProfileContext {
  immigrationStatus?: string | null;
  state?: string | null;
  city?: string | null;
  householdSize?: number | null;
  age?: number | null;
  numChildrenUnder18?: number | null;
  isPregnant?: boolean | null;
  isEmployedOrSeeking?: boolean | null;
  hasEad?: boolean | null;
  hasSsn?: boolean | null;
  hasI94?: boolean | null;
  eligibilityDate?: string | null;
  arrivalDate?: string | null;
  statusGrantDate?: string | null;
}

interface RequestBody {
  query?: unknown;
  language?: unknown;
  profile?: unknown;
  documentFields?: unknown;
}

// Strip any concrete sensitive number format out of a free-text string before
// it is ever sent to Claude. Never echo SSN / A-Number / bank numbers.
function scrub(text: string): string {
  let safe = text;
  for (const pattern of SENSITIVE_NUMBER_PATTERNS) {
    safe = safe.replace(pattern, "[REDACTED]");
  }
  return safe;
}

function buildContextBlock(
  profile: ProfileContext | null,
  documentFields: string[],
): string {
  const lines: string[] = [];

  if (profile) {
    const p = profile;
    const facts: string[] = [];
    if (p.immigrationStatus) facts.push(`Immigration status: ${p.immigrationStatus}`);
    if (p.state) facts.push(`State: ${p.state}`);
    if (p.city) facts.push(`City: ${p.city}`);
    if (typeof p.age === "number") facts.push(`Age: ${p.age}`);
    if (typeof p.householdSize === "number") facts.push(`Household size: ${p.householdSize}`);
    if (typeof p.numChildrenUnder18 === "number")
      facts.push(`Children under 18: ${p.numChildrenUnder18}`);
    if (p.isPregnant != null) facts.push(`Pregnant: ${p.isPregnant ? "yes" : "no"}`);
    if (p.isEmployedOrSeeking != null)
      facts.push(`Employed or seeking work: ${p.isEmployedOrSeeking ? "yes" : "no"}`);
    if (p.hasEad != null) facts.push(`Has work permit (EAD): ${p.hasEad ? "yes" : "no"}`);
    if (p.hasSsn != null) facts.push(`Has SSN on file: ${p.hasSsn ? "yes" : "no"}`);
    if (p.hasI94 != null) facts.push(`Has I-94: ${p.hasI94 ? "yes" : "no"}`);
    if (p.eligibilityDate) facts.push(`ORR eligibility date: ${p.eligibilityDate}`);
    if (p.arrivalDate) facts.push(`Arrival date: ${p.arrivalDate}`);
    if (p.statusGrantDate) facts.push(`Status grant date: ${p.statusGrantDate}`);

    if (facts.length > 0) {
      lines.push("This user's situation (use it to personalize your answer):");
      lines.push(facts.map((f) => `- ${scrub(f)}`).join("\n"));
    }
  }

  if (documentFields.length > 0) {
    lines.push(
      "The user has uploaded documents containing these field names (names only, never the values):",
    );
    lines.push(documentFields.map((f) => `- ${scrub(f)}`).join("\n"));
  }

  return lines.join("\n\n");
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse the body defensively — a malformed JSON body must not 500 with HTML.
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { query, language, profile, documentFields } = body;

  if (typeof query !== "string" || !query.trim()) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }
  const lang = typeof language === "string" && language ? language : "en";

  // Validate the optional context — never trust the client to send the right shape.
  const profileContext: ProfileContext | null =
    profile && typeof profile === "object" ? (profile as ProfileContext) : null;
  const docFields: string[] = Array.isArray(documentFields)
    ? documentFields.filter((f): f is string => typeof f === "string").slice(0, 50)
    : [];

  const contextBlock = buildContextBlock(profileContext, docFields);

  const claude = getClaudeClient();

  try {
    const response = await claude.messages.create({
      model: HAIKU,
      max_tokens: 2048,
      system: `You are a helpful immigration benefits form assistant. You help users understand U.S. government forms and what to write in each field.

CRITICAL RULES:
1. NEVER fill in, suggest, or ask the user to provide: SSN, Social Security Number, A-Number, Alien Registration Number, passport number, bank account number, routing number, or any financial credentials. For any of these fields, respond with "[YOU FILL IN] — enter your [field name] here. Do not share this number with us." Never echo any such number back, even if it appears in the conversation.
2. If the form or question is related to immigration status, removal proceedings, or anything requiring legal judgment, say clearly: "This requires a licensed attorney or DOJ-accredited representative. I cannot give legal advice on this."
3. Write your response in language code: ${lang}. If language is "en", respond in English.
4. Be warm, simple, and clear. Assume the user may have low literacy. Use plain language.
5. Format your response clearly with numbered steps or sections.
6. Use the user's situation provided in the user message to personalize your guidance. Do not restate sensitive numbers.`,
      messages: [
        {
          role: "user",
          content: `${contextBlock ? `${contextBlock}\n\n` : ""}Help me with: ${query}

For any sensitive fields like ${SENSITIVE_FIELDS.join(", ")}, mark them as [YOU FILL IN] and do not fill them in.`,
        },
      ],
    });

    // Extract text robustly across ALL blocks, not just content[0].
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      return NextResponse.json(
        { error: "The assistant returned an empty response. Please try again." },
        { status: 502 },
      );
    }

    // Non-destructive safety net: redact only concrete sensitive number formats,
    // every occurrence (global flag). The model is already prompted to emit
    // [YOU FILL IN] for these fields, so we never rewrite benign label words.
    let safeText = text;
    for (const pattern of SENSITIVE_NUMBER_PATTERNS) {
      safeText = safeText.replace(pattern, "[YOU FILL IN]");
    }

    return NextResponse.json({ response: safeText });
  } catch (error) {
    // Map typed SDK errors to user-facing messages. Never leak raw error text.
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = error.headers?.get("retry-after") ?? undefined;
      return NextResponse.json(
        {
          error: "The assistant is busy right now. Please wait a moment and try again.",
          ...(retryAfter ? { retryAfter } : {}),
        },
        { status: 429 },
      );
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      // Real cause is an API-key/permission problem — log for ops, hide from user.
      console.error("[form-assist] auth/permission error:", error);
      return NextResponse.json(
        { error: "The form assistant is temporarily unavailable. Please try again later." },
        { status: 503 },
      );
    }
    if (error instanceof Anthropic.InternalServerError) {
      return NextResponse.json(
        { error: "The assistant is temporarily unavailable. Please try again in a few minutes." },
        { status: 503 },
      );
    }
    if (error instanceof Anthropic.BadRequestError) {
      console.error("[form-assist] bad request to Claude:", error);
      return NextResponse.json(
        { error: "Something went wrong processing your request." },
        { status: 500 },
      );
    }
    if (error instanceof Anthropic.APIError) {
      // Catches overloaded (529) and any other API-level error.
      if (error.status === 429) {
        const retryAfter = error.headers?.get("retry-after") ?? undefined;
        return NextResponse.json(
          {
            error: "The assistant is busy right now. Please wait a moment and try again.",
            ...(retryAfter ? { retryAfter } : {}),
          },
          { status: 429 },
        );
      }
      console.error("[form-assist] Claude API error:", error);
      return NextResponse.json(
        { error: "The assistant is temporarily unavailable. Please try again in a few minutes." },
        { status: 503 },
      );
    }
    // Network, timeout, or any other unexpected error.
    console.error("[form-assist] unexpected error:", error);
    return NextResponse.json(
      { error: "We could not reach the form assistant. Check your connection and try again." },
      { status: 503 },
    );
  }
}
