import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, SONNET } from "@/lib/claude";

// ─────────────────────────────────────────────────────────────────────────────
// Form field mapping (Sonnet).
//
// The browser detects a form's fields (exact AcroForm rectangles, or label-
// anchored spots from the rendered text layer) and sends each one's nearby
// label/context plus the user's NON-SENSITIVE saved data (onboarding profile +
// document fields). Sonnet decides, per field, which value belongs there — this
// handles coded field names, abbreviations, and odd labels that regex can't.
//
// Safety:
//   • Sensitive fields (SSN, A-Number, USCIS #, passport, bank, password,
//     signature) are NEVER filled — the model flags them and we also enforce it
//     by scrubbing every returned value.
//   • The model may only use values present in DATA; it is told never to invent.
//   • One Sonnet call per form load — cheap and bounded.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const MAX_FIELDS = 90;
const MAX_DATA = 8_000;

// Defense-in-depth: never let a sensitive-looking value reach the browser, even
// if the model produced one against instructions.
const SCRUBBERS: Array<RegExp> = [
  /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/, // SSN
  /\bA[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{2,3}\b/i, // A-Number
  /\b\d{9,}\b/, // long digit runs (passport/bank)
  /\b(?:\d[ -]?){13,19}\b/, // card-style groups
];

function looksSensitive(v: string): boolean {
  return SCRUBBERS.some((re) => re.test(v));
}

const SYSTEM = `You map a person's saved information onto the fields of a U.S. government / benefits form.

You receive:
- DATA: the person's known, non-sensitive information (from their onboarding profile and uploaded documents), as JSON.
- FIELDS: an array of { id, label } where label is the field's visible name or nearby text on the form.

You also receive FORMTEXT: the visible text from the form's first page, to help you identify the form and understand each field in context.

For EACH field, choose the single best value from DATA.

Also write a SUMMARY: one or two short, plain-language sentences (≈6th-grade reading level) saying what this form is and what it is used for, based on FORMTEXT. Example: "This is IRS Form W-9. U.S. businesses use it to collect your name, address, and taxpayer ID so they can report payments they make to you."

Rules:
- BE CONSERVATIVE. Only fill a field when DATA clearly contains the value for THAT specific field. When unsure, return value: null — leaving a field blank is ALWAYS better than guessing. Most fields on a form will be null.
- Use ONLY values that appear in DATA. Never invent, guess, or infer a value that isn't there.
- A person applying for themselves does NOT have a "business name", "entity name", "trade name", "DBA", or "account number". Leave those null unless DATA explicitly contains a business/account value. NEVER copy the person's name into a business, entity, account, classification, exemption, or checkbox field.
- Do NOT fill checkbox/selection/option fields, tax-classification options, exemption codes, or any field that is really an instruction fragment rather than a labeled blank — ALWAYS return value: null for those. We never auto-check a box.
- CHECKBOX / OPTION / RADIO LABELS: When a field is a checkbox or one choice in a set of options, its label is ALREADY the SPECIFIC option text (the words next to that box). Your "label" MUST faithfully restate THAT specific option, not a generic category for the whole group. For example, for the IRS W-9 tax-classification checkboxes the labels are option texts like "Individual/sole proprietor or single-member LLC", "C corporation", "S corporation", "Partnership", "Trust/estate", "Limited liability company", "Other" — so return label "Sole proprietor", "C corporation", "S corporation", "Partnership", "Trust or estate", "LLC", "Other" respectively. NEVER collapse them to a generic "Tax classification", "Federal tax classification", "Choose an option", or "This field". Keep value: null for every one of these.
- Match by MEANING, not exact words: e.g. "Family name"/"Surname" → last name; "Given name"/"First name" → first name; "D.O.B."/"Date of birth" → date of birth; "Mailing address"/"Street" → address; "City or town" → city; "Country of birth"/"Nationality" → country.
- SENSITIVE: mark sensitive: true and value: null ONLY for a Social Security Number (SSN), Individual Taxpayer ID (ITIN), Employer ID Number (EIN), any other Taxpayer Identification Number (TIN), Alien/A-Number, USCIS number, passport number, a bank account or routing number, a password, or a signature. Do NOT mark a person's name, business name, street address, city, state, ZIP, country, phone, email, or an optional reference/"account number" on a form as sensitive — those are not sensitive.
- OVERRIDE: If a field's label CONTAINS any of "social security", "SSN", "ITIN", "EIN", "TIN", "employer identification", or "taxpayer identification", it MUST be sensitive: true and value: null — no matter what else the label says and regardless of any rule above.
- Keep the value's formatting exactly as it appears in DATA (don't reformat dates).
- For EACH field also write:
  - "label": a SHORT, plain-language name for the field — 2 to 4 words, simple enough for someone new to the U.S. with limited English. Examples: "Your full name", "Home address", "City and ZIP", "Tax ID number". NEVER copy the form's long legal wording.
  - "help": ONE short everyday sentence (max 15 words) telling the person what to put there. For sensitive fields, say plainly what it is and that they enter it themselves on the official site.
- Output ONLY valid JSON, no prose, no code fences, in this exact shape:
{"summary":"<one or two sentences>","mappings":[{"id":"<field id>","value":<string or null>,"sensitive":<true or false>,"label":"<2-4 plain words>","help":"<one short sentence>"}]}
Return one mapping entry for every field id you were given.`;

interface MapBody {
  fields?: unknown;
  data?: unknown;
  formText?: unknown;
}

interface OutField {
  id: string;
  value: string | null;
  sensitive: boolean;
  label: string;
  help: string;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: MapBody;
  try {
    body = (await req.json()) as MapBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Validate + cap inputs.
  const rawFields = Array.isArray(body.fields) ? body.fields : [];
  const fields = rawFields
    .slice(0, MAX_FIELDS)
    .map((f) => {
      const o = f as { id?: unknown; label?: unknown };
      return {
        id: typeof o.id === "string" ? o.id : "",
        label: typeof o.label === "string" ? o.label.slice(0, 200) : "",
      };
    })
    .filter((f) => f.id);
  if (fields.length === 0) {
    return NextResponse.json({ ok: true, mappings: [] });
  }

  const data =
    body.data && typeof body.data === "object" ? body.data : {};
  const dataJson = JSON.stringify(data).slice(0, MAX_DATA);
  const formText = (typeof body.formText === "string" ? body.formText : "").slice(0, 3_000);

  const userMessage = [
    "DATA (the person's saved, non-sensitive information):",
    dataJson,
    "",
    "FORMTEXT (visible text from the form's first page):",
    formText || "(none)",
    "",
    "FIELDS to map:",
    JSON.stringify(fields),
  ].join("\n");

  const claude = getClaudeClient();
  let rawText = "";
  try {
    const response = await claude.messages.create({
      model: SONNET,
      max_tokens: 2_000,
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }],
    });
    const first = response.content[0];
    rawText = first && first.type === "text" ? first.text : "";
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Busy, try again shortly." }, { status: 429 });
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return NextResponse.json({ error: "Temporarily unavailable." }, { status: 503 });
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json({ error: "Could not map fields." }, { status: 502 });
    }
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }

  // Parse the model's JSON (tolerate stray code fences / prose around it).
  let mappings: OutField[] = [];
  let summary = "";
  try {
    const jsonStart = rawText.indexOf("{");
    const jsonEnd = rawText.lastIndexOf("}");
    const slice = jsonStart >= 0 && jsonEnd > jsonStart ? rawText.slice(jsonStart, jsonEnd + 1) : rawText;
    const parsed = JSON.parse(slice) as { mappings?: unknown; summary?: unknown };
    summary = typeof parsed.summary === "string" ? scrubSummary(parsed.summary).slice(0, 400) : "";
    const arr = Array.isArray(parsed.mappings) ? parsed.mappings : [];
    mappings = arr.map((m) => {
      const o = m as { id?: unknown; value?: unknown; sensitive?: unknown; label?: unknown; help?: unknown };
      const id = typeof o.id === "string" ? o.id : "";
      const sensitive = o.sensitive === true;
      let value = typeof o.value === "string" ? o.value.trim() : null;
      // Enforce the no-sensitive-values rule regardless of the model's flag.
      if (value && (sensitive || looksSensitive(value))) value = null;
      const label = typeof o.label === "string" ? scrubSummary(o.label).slice(0, 60) : "";
      const help = typeof o.help === "string" ? scrubSummary(o.help).slice(0, 200) : "";
      return { id, value: value || null, sensitive, label, help } as OutField;
    }).filter((m) => m.id);
  } catch {
    return NextResponse.json({ error: "Could not parse mapping." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, mappings, summary });
}

// Scrub any sensitive-looking number out of the summary, just in case.
function scrubSummary(s: string): string {
  let out = s;
  for (const re of SCRUBBERS) out = out.replace(new RegExp(re, "g"), "[number]");
  return out;
}
