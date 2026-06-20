// Shared, server-safe extraction logic for the onboarding document reader.
//
// This module is PURE (no network, no DB, no Next): it owns the vision prompt
// and the parse/validate/derive step so the exact same logic can be unit-tested
// against real document fixtures (scripts/test-i94-extraction.mjs) and reused by
// the API route (app/api/onboarding/extract/route.ts).
//
// Field-mapping safety is the whole point of this file:
//   • Each field is validated to its own type (ISO date, enum, …).
//   • Dates are confined to their OWN slot — a date of birth can never be read
//     off an entry/issue/expiry date, and vice-versa.
//   • A cross-field guard demotes a date_of_birth that collides with an
//     arrival / eligibility / status-grant date to "low" confidence, because a
//     birth date equal to an entry date is almost certainly a mis-read. The
//     client then leaves low-confidence fields blank for manual entry.

import type { ImmigrationStatus } from "@/lib/types";

export type Confidence = "high" | "medium" | "low";
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);

export const VALID_STATUSES = new Set<ImmigrationStatus>([
  "refugee_207", "asylee_208", "siv", "afghan_parolee", "ukrainian_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
  "lpr_from_humanitarian", "lpr_other", "us_citizen", "other_none",
]);

export type DocType = "i94" | "ead" | "green_card" | "asylum_letter" | "ssn_card" | "other";
export const VALID_DOCS = new Set<DocType>([
  "i94", "ead", "green_card", "asylum_letter", "ssn_card", "other",
]);

export interface Field<T> { value: T; confidence: Confidence }

export interface ExtractedFields {
  immigration_status?: Field<ImmigrationStatus>;
  date_of_birth?: Field<string>;
  age?: Field<number>;
  arrival_date?: Field<string>;
  eligibility_date?: Field<string>;
  status_grant_date?: Field<string>;
  full_name?: Field<string>;
  country_of_origin?: Field<string>;
}

export interface ExtractionResult {
  documents_detected: DocType[];
  fields: ExtractedFields;
  booleans: { has_i94?: boolean; has_ead?: boolean; has_adjusted_to_lpr?: boolean };
  notes: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  // Reject future dates and absurdly old ones.
  if (d.getTime() > Date.now()) return null;
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

export const EXTRACT_PROMPT = `You are a careful, privacy-preserving document reader for a U.S. refugee benefits navigator. The user uploaded one or more photos/scans of their immigration documents to speed up onboarding.

For EACH image, first classify the document as one of: i94, ead (Employment Authorization Document / Form I-766 work permit), green_card (Form I-551 permanent resident card), asylum_letter (asylum approval / I-797 approval notice / immigration judge grant), ssn_card (Social Security card), other.

Then extract ONLY the fields listed below, across all documents combined.

NEVER output, transcribe, or guess any of these (they are sensitive and not needed): Social Security Number, A-Number / Alien Registration Number, USCIS number, passport number, bank/financial numbers. If a Social Security card is uploaded, classify it as ssn_card and extract NOTHING from it.

CRITICAL — keep dates in their correct field. These are DIFFERENT dates and must never be swapped:
- date_of_birth = the person's BIRTH date (labels: "Birth Date", "Date of Birth", "DOB"). It is in the past, usually decades ago.
- arrival_date = the date of ADMISSION / ENTRY to the U.S. (labels: "Most Recent Date of Entry", "Date of Entry", "Admission Date"). This is NOT the birth date.
- status_grant_date = the date refugee/asylee status was granted.
- An "Admit Until Date" / expiration / issue date is NOT any of the above — do not map it.
If a value is only legible as one of these, fill that one field and leave the others out. Never copy the entry date into date_of_birth or vice-versa. If you are unsure which date a value is, mark it "low" confidence.

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

// Pull the first JSON object out of a model reply without ever throwing.
function safeJsonObject(rawText: string): Record<string, unknown> {
  try {
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(rawText.slice(start, end + 1));
  } catch {
    /* fall through */
  }
  return {};
}

// Parse + validate + derive. Pure: same input → same output (except `age`, which
// is relative to today). This is the single source of truth for field mapping.
export function parseExtraction(rawText: string): ExtractionResult {
  const parsed = safeJsonObject(rawText);

  const documents_detected = (Array.isArray(parsed.documents_detected) ? parsed.documents_detected : [])
    .filter((d): d is DocType => typeof d === "string" && VALID_DOCS.has(d as DocType));

  const raw = (parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {}) as Record<string, { value?: unknown; confidence?: unknown }>;
  const getStr = (k: string) => (raw[k] && typeof raw[k].value === "string" ? (raw[k].value as string).trim() : "");

  const out: ExtractedFields = {};

  // immigration_status — validate against the enum.
  const statusVal = getStr("immigration_status") as ImmigrationStatus;
  if (VALID_STATUSES.has(statusVal) && statusVal !== "other_none") {
    out.immigration_status = { value: statusVal, confidence: conf(raw.immigration_status?.confidence) };
  }

  // Dates — validate ISO + not in the future. Each lands ONLY in its own slot.
  for (const key of ["date_of_birth", "arrival_date", "eligibility_date", "status_grant_date"] as const) {
    const v = cleanDate(getStr(key));
    if (v) out[key] = { value: v, confidence: conf(raw[key]?.confidence) };
  }

  // Cross-field guard: a birth date must never equal an arrival / eligibility /
  // status-grant date. If it does, the reader almost certainly mis-mapped an
  // entry/issue date into date_of_birth — demote it to "low" so the client
  // leaves it blank and asks the user to confirm rather than trusting it.
  if (out.date_of_birth) {
    const dob = out.date_of_birth.value;
    const collides = [out.arrival_date?.value, out.eligibility_date?.value, out.status_grant_date?.value]
      .some((d) => d && d === dob);
    if (collides) out.date_of_birth.confidence = "low";
  }

  // Display-only text fields.
  for (const key of ["full_name", "country_of_origin"] as const) {
    const v = getStr(key);
    if (v) out[key] = { value: v.slice(0, 80), confidence: conf(raw[key]?.confidence) };
  }

  // Server-side derivations (deterministic).
  // 1) age from date_of_birth (only when we still trust the birth date).
  if (out.date_of_birth && out.date_of_birth.confidence !== "low") {
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

  return { documents_detected, fields: out, booleans, notes };
}
