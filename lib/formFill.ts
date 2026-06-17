// Field mapping + flagging logic for the custom PDF form-fill page.
//
// Pure, client-safe helpers (no React, no pdf-lib, no DOM) so the mapping rules
// can be reasoned about and reused independently of the rendering component.
//
// HARD RULES (per project constraints):
//   - Sensitive numbers (SSN, A-Number, passport, bank account/routing, card,
//     USCIS/immigration doc numbers) are NEVER auto-filled. They are flagged
//     "sensitive" and the user is coached to type them in themselves.
//   - We NEVER invent values. A field only gets an auto-filled value when the
//     profile actually has the corresponding data; otherwise it is "missing".

import type { Profile } from "@/lib/types";

export type FieldFlag = "auto" | "missing" | "sensitive";

// A normalized, non-sensitive view of the user's confirmed profile data, keyed
// by the canonical attributes a form might ask for. Values are strings ready to
// write into a PDF text field. Sensitive numbers are deliberately absent.
export interface ProfileValues {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  dateOfBirth?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  countryOfBirth?: string;
  arrivalDate?: string;
  householdSize?: string;
  age?: string;
}

// US-style date for display/fill (MM/DD/YYYY) from an ISO-ish date string. We
// only reformat when the input clearly parses; otherwise pass it through so we
// never corrupt a value the user already confirmed.
function usDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return value.trim();
}

function nonEmpty(v: string | null | undefined): string | undefined {
  const s = (v ?? "").trim();
  return s.length ? s : undefined;
}

// Build the canonical, NON-SENSITIVE value bag from the profile. Note there is
// no name field on Profile in this app (intake collects status/location/
// household, not legal name), so first/last/full name come out undefined and
// those PDF fields will correctly fall through to "missing" rather than being
// invented.
export function profileToValues(profile: Profile | undefined): ProfileValues {
  if (!profile) return {};
  return {
    dateOfBirth: undefined, // not collected at intake -> stays "missing"
    address: undefined, // street address not collected -> "missing"
    city: nonEmpty(profile.city),
    state: nonEmpty(profile.state),
    zip: nonEmpty(profile.zip_code),
    phone: undefined,
    countryOfBirth: undefined,
    arrivalDate: usDate(profile.arrival_date),
    householdSize:
      profile.household_size != null ? String(profile.household_size) : undefined,
    age: profile.age != null ? String(profile.age) : undefined,
  };
}

// Merge in any non-sensitive fields the user already confirmed from uploaded
// documents (extracted_fields). We pull a small allow-list of clearly
// non-sensitive keys and never anything that looks like a sensitive number.
export function mergeDocumentFields(
  base: ProfileValues,
  extracted: Record<string, string> | null | undefined,
): ProfileValues {
  if (!extracted) return base;
  const out = { ...base };
  for (const [rawKey, rawVal] of Object.entries(extracted)) {
    const val = nonEmpty(rawVal);
    if (!val) continue;
    const key = rawKey.toLowerCase();
    if (isSensitiveName(key)) continue; // never carry sensitive doc values forward
    if (/(first.?name|given.?name)/.test(key)) out.firstName ??= val;
    else if (/(last.?name|surname|family.?name)/.test(key)) out.lastName ??= val;
    else if (/(full.?name|^name$|legal.?name)/.test(key)) out.fullName ??= val;
    else if (/(date.?of.?birth|birth.?date|dob)/.test(key)) out.dateOfBirth ??= usDate(val);
    else if (/(street|address)/.test(key)) out.address ??= val;
    else if (/city/.test(key)) out.city ??= val;
    else if (/state|province/.test(key)) out.state ??= val;
    else if (/zip|postal/.test(key)) out.zip ??= val;
    else if (/phone|tel/.test(key)) out.phone ??= val;
    else if (/country.?of.?(birth|origin)|birth.?country|nationality/.test(key))
      out.countryOfBirth ??= val;
    else if (/arrival|date.?of.?entry|entry.?date/.test(key)) out.arrivalDate ??= usDate(val);
  }
  // Derive first/last name from a document's full name when we have the whole
  // but not the parts. Split on the LAST space so multi-word given names stay
  // together (e.g. "Maria Del Carmen Lopez" -> first "Maria Del Carmen",
  // last "Lopez").
  if (out.fullName) {
    const trimmed = out.fullName.trim();
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace > 0) {
      out.firstName ??= trimmed.slice(0, lastSpace).trim();
      out.lastName ??= trimmed.slice(lastSpace + 1).trim();
    } else {
      out.firstName ??= trimmed;
    }
  }
  // Conversely, assemble a full name if we only have the parts.
  if (!out.fullName && (out.firstName || out.lastName)) {
    out.fullName = [out.firstName, out.lastName].filter(Boolean).join(" ");
  }
  return out;
}

// Sensitive-field detection. A field whose NAME matches any of these is never
// auto-filled, regardless of available data.
const SENSITIVE_RE =
  /ssn|social.?security|alien|a-?number|a\s*#|a#|uscis|account|routing|\bcard\b|passport|i-?94\s*number|receipt.?number|bank/i;

export function isSensitiveName(fieldName: string): boolean {
  return SENSITIVE_RE.test(fieldName);
}

// Map a single PDF field name to a profile value. Returns the value to fill, or
// undefined if we have no data for it. Pure name-based matching — common
// synonyms for the attributes we actually hold.
export function valueForField(
  fieldName: string,
  values: ProfileValues,
): string | undefined {
  const n = fieldName.toLowerCase();

  // Order matters: check the most specific patterns first.
  if (/(first.?name|given.?name|f\.?name)/.test(n)) return values.firstName;
  if (/(last.?name|surname|family.?name|l\.?name)/.test(n)) return values.lastName;
  if (/(full.?name|legal.?name|applicant.?name|\bname\b)/.test(n)) return values.fullName;
  if (/(date.?of.?birth|birth.?date|\bdob\b)/.test(n)) return values.dateOfBirth;
  if (/(street|home.?address|mailing.?address|\baddress\b|address.?line)/.test(n))
    return values.address;
  if (/\bcity\b|town/.test(n)) return values.city;
  if (/\bstate\b|province/.test(n)) return values.state;
  if (/\bzip\b|postal|zip.?code/.test(n)) return values.zip;
  if (/phone|telephone|\btel\b|mobile|cell/.test(n)) return values.phone;
  if (/country.?of.?birth|birth.?country|nationality|country/.test(n))
    return values.countryOfBirth;
  if (/arrival|date.?of.?entry|entry.?date|date.?of.?arrival/.test(n))
    return values.arrivalDate;
  if (/household.?size|family.?size|number.?in.?household|people.?in.?home/.test(n))
    return values.householdSize;
  if (/\bage\b/.test(n)) return values.age;

  return undefined;
}

// Decide the flag + initial value for a field. The single source of truth used
// by both the AcroForm path and the flat-overlay fallback.
export function resolveField(
  fieldName: string,
  values: ProfileValues,
): { flag: FieldFlag; value: string } {
  if (isSensitiveName(fieldName)) {
    return { flag: "sensitive", value: "" };
  }
  const v = valueForField(fieldName, values);
  if (v != null && v !== "") {
    return { flag: "auto", value: v };
  }
  return { flag: "missing", value: "" };
}
