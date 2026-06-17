import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, HAIKU } from "@/lib/claude";
import type { ImmigrationStatus } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding document extraction — IN-MEMORY ONLY.
//
// The user uploads a photo/PDF of their I-94, EAD, green card, or asylum grant
// letter. A vision model reads ONLY the eligibility-relevant fields and returns
// them with a per-field confidence. We never persist the image (no storage, no
// DB) and never extract A-Number / SSN / passport / financial identifiers —
// those are sensitive and the deterministic engine does not need them.
//
// Output uses the EXACT variable names from database/eligibility-schema.js so the
// onboarding form can prefill them and the engine consumes them unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

type Confidence = "high" | "medium" | "low";
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);

const VALID_STATUSES = new Set<ImmigrationStatus>([
  "refugee_207", "asylee_208", "siv", "afghan_parolee", "ukrainian_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
  "lpr_from_humanitarian", "lpr_other", "us_citizen", "other_none",
]);

type DocType = "i94" | "ead" | "green_card" | "asylum_letter" | "ssn_card" | "other";
const VALID_DOCS = new Set<DocType>([
  "i94", "ead", "green_card", "asylum_letter", "ssn_card", "other",
]);

const MAX_FILES = 4;
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB per file
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF_TYPE = "application/pdf";

// Field shape returned to the client: { value, confidence }.
interface Field<T> { value: T; confidence: Confidence }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  // Reject future dates and absurdly old ones.
  const now = Date.now();
  if (d.getTime() > now) return null;
  if (d.getFullYear() < 1900) return null;
  return v;
}

function ageFromDob(dob: string): number | null {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age <= 120 ? age : null;
}

function conf(v: unknown): Confidence {
  return typeof v === "string" && CONFIDENCES.has(v as Confidence) ? (v as Confidence) : "low";
}

const PROMPT = `You are a careful, privacy-preserving document reader for a U.S. refugee benefits navigator. The user uploaded one or more photos/scans of their immigration documents to speed up onboarding.

For EACH image, first classify the document as one of: i94, ead (Employment Authorization Document / Form I-766 work permit), green_card (Form I-551 permanent resident card), asylum_letter (asylum approval / I-797 approval notice / immigration judge grant), ssn_card (Social Security card), other.

Then extract ONLY the fields listed below, across all documents combined.

NEVER output, transcribe, or guess any of these (they are sensitive and not needed): Social Security Number, A-Number / Alien Registration Number, USCIS number, passport number, bank/financial numbers. If a Social Security card is uploaded, classify it as ssn_card and extract NOTHING from it.

Fields to extract (omit any you cannot read):
- immigration_status: map the document to EXACTLY one of these codes:
    refugee_207  (I-94 class of admission RE / R8 / "Visa 93" / "Refugee"; EAD category A03; green card category RE-6/RE-7)
    asylee_208   (asylum granted / I-94 "AS"; EAD category A05; green card AS-6/AS-7; asylum approval letter)
    siv          (Special Immigrant Visa; I-94 "SI"/"SQ"/"IV")
    afghan_parolee     (parole tied to Afghanistan / "OAR" / Operation Allies Welcome)
    ukrainian_parolee  ("U4U" / Uniting for Ukraine / "UHP")
    cuban_haitian_entrant
    trafficking_victim (T nonimmigrant)
    amerasian
    lpr_from_humanitarian  (a GREEN CARD whose category shows refugee/asylee/humanitarian origin, e.g. RE-6, AS-6)
    lpr_other              (a green card from any other category)
    us_citizen
    other_none             (cannot tell)
  Include the literal code/text you saw in "evidence".
- date_of_birth (YYYY-MM-DD)
- arrival_date (YYYY-MM-DD) — date of admission/entry, typically from an I-94
- eligibility_date (YYYY-MM-DD) — for a refugee this equals the date of admission; for an asylee this equals the asylum grant date
- status_grant_date (YYYY-MM-DD) — date refugee/asylee status was granted (asylum letters/I-797)
- full_name (display only)
- country_of_origin (display only)

Give each extracted field a confidence: "high" (clearly printed and unambiguous), "medium" (legible but inferred/partial), or "low" (blurry, partly obscured, or guessed).

Return ONLY a JSON object, no prose, in EXACTLY this shape (omit fields you cannot read; never include fields not listed):
{
  "documents_detected": ["i94"],
  "fields": {
    "immigration_status": { "value": "refugee_207", "confidence": "high", "evidence": "Class of admission: RE" },
    "date_of_birth": { "value": "1990-04-12", "confidence": "high" },
    "arrival_date": { "value": "2024-09-01", "confidence": "high" },
    "eligibility_date": { "value": "2024-09-01", "confidence": "medium" },
    "status_grant_date": { "value": "2024-09-01", "confidence": "low" },
    "full_name": { "value": "Jane Doe", "confidence": "high" },
    "country_of_origin": { "value": "Afghanistan", "confidence": "medium" }
  }
}`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload. Please try again." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Please upload at most ${MAX_FILES} documents at a time.` }, { status: 400 });
  }

  // Build Claude content blocks in memory. Nothing is written to disk or storage.
  const content: Anthropic.ContentBlockParam[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Each file must be under 6 MB. Try a smaller photo." }, { status: 400 });
    }
    const type = file.type;
    const isImage = IMAGE_TYPES.has(type);
    const isPdf = type === PDF_TYPE;
    if (!isImage && !isPdf) {
      return NextResponse.json(
        { error: "Unsupported file type. Upload a JPEG, PNG, WEBP, or PDF." },
        { status: 400 }
      );
    }
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    if (isPdf) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
    } else {
      content.push({
        type: "image",
        source: { type: "base64", media_type: type as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 },
      });
    }
  }
  content.push({ type: "text", text: PROMPT });

  const claude = getClaudeClient();
  let rawText: string;
  try {
    const response = await claude.messages.create({
      model: HAIKU,
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    });
    const first = response.content[0];
    rawText = first && first.type === "text" ? first.text : "";
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "We're a little busy right now. Please wait a moment and try again, or skip and answer the questions instead." },
        { status: 429 }
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: "We couldn't read your document right now. You can try again or skip and answer the questions." },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "Something went wrong reading your document. You can skip and answer the questions instead." },
      { status: 500 }
    );
  }

  // Robust JSON extraction — never throw to the client on a malformed reply.
  let parsed: Record<string, unknown> = {};
  try {
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start !== -1 && end > start) parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    parsed = {};
  }

  const documents_detected = (Array.isArray(parsed.documents_detected) ? parsed.documents_detected : [])
    .filter((d): d is DocType => typeof d === "string" && VALID_DOCS.has(d as DocType));

  const raw = (parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {}) as Record<string, { value?: unknown; confidence?: unknown }>;
  const getStr = (k: string) => (raw[k] && typeof raw[k].value === "string" ? (raw[k].value as string).trim() : "");

  const out: {
    immigration_status?: Field<ImmigrationStatus>;
    date_of_birth?: Field<string>;
    age?: Field<number>;
    arrival_date?: Field<string>;
    eligibility_date?: Field<string>;
    status_grant_date?: Field<string>;
    full_name?: Field<string>;
    country_of_origin?: Field<string>;
  } = {};

  // immigration_status — validate against the enum.
  const statusVal = getStr("immigration_status") as ImmigrationStatus;
  if (VALID_STATUSES.has(statusVal) && statusVal !== "other_none") {
    out.immigration_status = { value: statusVal, confidence: conf(raw.immigration_status?.confidence) };
  }

  // Dates — validate ISO + not in the future.
  for (const key of ["date_of_birth", "arrival_date", "eligibility_date", "status_grant_date"] as const) {
    const v = cleanDate(getStr(key));
    if (v) out[key] = { value: v, confidence: conf(raw[key]?.confidence) };
  }

  // Display-only text fields.
  for (const key of ["full_name", "country_of_origin"] as const) {
    const v = getStr(key);
    if (v) out[key] = { value: v.slice(0, 80), confidence: conf(raw[key]?.confidence) };
  }

  // Server-side derivations (deterministic, never weaker than the model).
  // 1) age from date_of_birth.
  if (out.date_of_birth) {
    const age = ageFromDob(out.date_of_birth.value);
    if (age !== null) out.age = { value: age, confidence: out.date_of_birth.confidence };
  }
  // 2) eligibility_date fallback: refugee -> arrival date; asylee -> grant date.
  if (!out.eligibility_date && out.immigration_status) {
    if (out.immigration_status.value === "refugee_207" && out.arrival_date) {
      out.eligibility_date = { value: out.arrival_date.value, confidence: "medium" };
    } else if (out.immigration_status.value === "asylee_208" && out.status_grant_date) {
      out.eligibility_date = { value: out.status_grant_date.value, confidence: "medium" };
    }
  }

  // Booleans derived from which documents were seen (more reliable than asking).
  const booleans = {
    has_i94: documents_detected.includes("i94") || undefined,
    has_ead: documents_detected.includes("ead") || undefined,
    has_adjusted_to_lpr: documents_detected.includes("green_card") || undefined,
  };

  const notes: string[] = [];
  if (documents_detected.includes("ssn_card")) {
    notes.push("We do not read Social Security cards. We'll ask a simple yes/no question about your SSN instead.");
  }
  if (Object.keys(out).length === 0 && documents_detected.every((d) => d === "other" || d === "ssn_card")) {
    notes.push("We couldn't confidently read this document. You can retake the photo or answer the questions instead.");
  }

  return NextResponse.json({
    ok: true,
    documents_detected,
    fields: out,
    booleans,
    notes,
  });
}
