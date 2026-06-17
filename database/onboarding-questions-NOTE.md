# Onboarding update — document scan replaces hand-typed status & dates

> Companion note to **onboarding-questions.docx**. The 24-question intake still
> defines every variable the deterministic engine needs; this note records which
> questions are now **pre-filled by document extraction** instead of asked by hand.
> The eligibility engine (`lib/eligibility/engine.ts`) and `benefits.js` are
> **unchanged** — only how variables are *collected* changed.

## New flow (`app/onboarding/page.tsx`)

1. **Language** (Q0).
2. **Scan** — "Take a photo of your I-94 (and work permit if you have one)", with a
   skip option ("I don't have my documents — answer questions instead").
3. **Confirm** — a single scrollable list of *every* value the vision model read
   (`app/api/onboarding/extract/route.ts`, `claude-sonnet-4-6`, `max_tokens` 1000,
   image/PDF input → JSON). Each value is editable inline; low-confidence fields are
   flagged **"Please check"** at the top. One **"Confirm and continue"** button. We
   never auto-proceed on extracted data.
4. **Follow-up questions** — only the variables no document contains.
5. The completed variable set is handed to the existing engine unchanged.

## Privacy

Uploaded documents (I-94, EAD, green card, asylum letter) are treated as the
highest-sensitivity category. They are processed **in memory only** — never written
to storage or the database in this demo — and only the fields below are kept. The
A-Number and SSN are **never** read on the eligibility path (handled later at
form-fill time under the coach-don't-autofill rule). Social Security cards are not
read at all.

## Which questions are now pre-filled by a document (still confirmed by the user)

| docx Q | Variable | Source document |
|--------|----------|-----------------|
| 1.1 | `immigration_status` | I-94 class of admission (e.g. RE → refugee_207), EAD category (A03/A05), green card category, asylum/I-797 letter |
| 3.1 | `eligibility_date` (`months_since_eligibility_date`) | I-94 (refugee: = admission date); asylum letter (asylee: = grant date) |
| 3.2 | `arrival_date` (`months_since_arrival`) | I-94 |
| 3.3 | `status_grant_date` (`years_since_status_grant`) | Asylum grant / I-797 approval; I-94 for refugees |
| 4.1 | `age` | Derived from date of birth on the document |
| 2.2 | `has_ead` | Set true when an EAD/I-766 is uploaded |
| 2.1 | `has_i94` | Set true when an I-94 is uploaded |
| — | `has_adjusted_to_lpr` (derived) | Set when a green card is uploaded → `immigration_status = lpr_from_humanitarian` |

Also captured for display/trust only (not used by any rule, not persisted): full
name, country of origin, date of birth.

## Which questions remain (no document contains them)

`has_ssn` (asked yes/no — number never read), `household_size`,
`household_gross_monthly_income`, `num_children_under_19` / `_18` / `_5`,
`is_pregnant`, `is_disabled`, `is_blind`, `has_40_work_quarters`,
`is_employed_or_seeking`, `wants_to_start_business`, `wants_english_classes`,
`needs_interpreter`, `is_unaccompanied_minor`, `has_orr_eligibility_letter`
(trafficking only), plus location (state/city/zip).

## Demo path

Scan a sample I-94 → the Confirm list shows status + arrival/eligibility dates +
DOB-derived age (low-confidence fields flagged) → confirm → a handful of follow-up
questions → eligibility results. Choosing "skip" falls back to the full manual
question flow, unchanged.
