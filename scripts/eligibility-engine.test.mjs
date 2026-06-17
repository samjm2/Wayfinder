// Standalone test for the deterministic eligibility engine.
// No DB, no Claude. Run with:  npx tsx scripts/eligibility-engine.test.mjs
//
// It imports the pure engine (TS) and the real benefits.json + FPL table,
// runs synthetic profiles, and asserts expected per-benefit statuses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runEngine } from "../lib/eligibility/engine.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const benefits = JSON.parse(readFileSync(join(root, "database", "benefits.json"), "utf8"));
const fpl = JSON.parse(readFileSync(join(root, "data", "fpl_2025.json"), "utf8"));

const NOW = new Date("2026-06-16");

// Minimal profile factory — all fields default to null/false unless overridden.
function profile(overrides) {
  return {
    id: "test",
    email: null,
    language_code: "en",
    immigration_status: null,
    has_i94: null,
    has_ead: null,
    has_ssn: null,
    has_orr_eligibility_letter: null,
    eligibility_date: null,
    arrival_date: null,
    status_grant_date: null,
    state: null,
    city: null,
    zip_code: null,
    age: null,
    household_size: null,
    household_gross_monthly_income: null,
    num_children_under_19: null,
    num_children_under_18: null,
    num_children_under_5: null,
    is_pregnant: null,
    receives_other_cash_benefit: null,
    is_unaccompanied_minor: null,
    is_disabled: null,
    is_blind: null,
    has_40_work_quarters: null,
    is_employed_or_seeking: null,
    wants_to_start_business: null,
    wants_english_classes: null,
    needs_interpreter: null,
    onboarding_complete: true,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got "${actual}", expected "${expected}")`);
}

function statusOf(results, id) {
  const b = results.find((x) => x.id === id);
  return b ? b.status : "(missing)";
}

// ── Case 1: Recently-arrived refugee, low income, child under 19 ─────────────
// Eligible for RCA path & ORR programs; TANF passes income (review flag).
{
  const p = profile({
    immigration_status: "refugee_207",
    eligibility_date: "2026-05-01", // >= may5 2025 -> 4-month window, ~1.5mo in
    arrival_date: "2026-05-01",
    status_grant_date: "2026-05-01",
    age: 30,
    household_size: 3,
    household_gross_monthly_income: 0,
    num_children_under_19: 2,
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 1: recent refugee, low income, has child ==");
  // RCA: ORR, not TANF-eligible? With a child + low income, eligible_for_tanf is
  // true -> RCA's "not eligible_for_tanf" fails -> not_eligible. That's correct.
  check("rca", statusOf(r, "rca"), "not_eligible");
  check("tanf", statusOf(r, "tanf"), "needs_human_review"); // fpl review:true
  check("reception_placement", statusOf(r, "reception_placement"), "likely_eligible");
  check("medical_screening", statusOf(r, "medical_screening"), "likely_eligible");
}

// ── Case 2: Refugee, no child, low income -> RCA should be available ─────────
{
  const p = profile({
    immigration_status: "refugee_207",
    eligibility_date: "2026-05-20",
    arrival_date: "2026-05-20",
    status_grant_date: "2026-05-20",
    age: 28,
    household_size: 1,
    household_gross_monthly_income: 0,
    num_children_under_19: 0,
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 2: single refugee, no child, low income ==");
  check("rca", statusOf(r, "rca"), "likely_eligible");
}

// ── Case 3: other_none (undocumented) — should NOT qualify for ORR/qualified ─
{
  const p = profile({
    immigration_status: "other_none",
    arrival_date: "2026-01-01",
    age: 40,
    household_size: 2,
    household_gross_monthly_income: 1000,
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 3: other_none ==");
  check("rca", statusOf(r, "rca"), "not_eligible");
  check("snap", statusOf(r, "snap"), "not_eligible");
  check("ssi", statusOf(r, "ssi"), "not_eligible");
  // Legal services gates on is_qualified_alien (false here) -> fail -> not_eligible.
  check("legal_services", statusOf(r, "legal_services"), "not_eligible");
}

// ── Case 4: Missing data safety — refugee with almost nothing answered ───────
// Must NEVER produce all-not_eligible. Unknown -> needs_human_review.
{
  const p = profile({ immigration_status: "refugee_207" });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 4: refugee, mostly-missing data ==");
  const eligibleish = r.filter((b) => b.status !== "not_eligible");
  check("at least one non-not_eligible benefit", eligibleish.length > 0, true);
  // SSI requires age/disabled/blind (all unknown) within rule -> review.
  check("ssi", statusOf(r, "ssi"), "needs_human_review");
}

// ── Case 5: Legal/status always routes to human unless clearly excluded ──────
{
  const p = profile({
    immigration_status: "refugee_207",
    arrival_date: "2024-01-01",
    status_grant_date: "2024-01-01",
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 5: legal/status -> needs_human_review ==");
  check("adjustment_of_status", statusOf(r, "adjustment_of_status"), "needs_human_review");
  check("legal_services", statusOf(r, "legal_services"), "needs_human_review");
  check("adjustment needsAttorney", r.find((b) => b.id === "adjustment_of_status").needsAttorney, true);
}

// ── Case 6: maybe_eligible when income unknown but rule has fpl leaf ──────────
// LPR-from-humanitarian, no income/size given -> snap rule passes status leg,
// fpl leaf unresolved -> downgrade to maybe_eligible.
{
  const p = profile({
    immigration_status: "lpr_from_humanitarian",
    // household_gross_monthly_income & household_size intentionally null
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 6: income unknown + fpl leaf -> maybe_eligible ==");
  check("snap", statusOf(r, "snap"), "maybe_eligible");
}

// ── Case 7: SSI elderly refugee within 7 years ───────────────────────────────
{
  const p = profile({
    immigration_status: "refugee_207",
    status_grant_date: "2023-01-01", // ~3.5 years -> within 7
    age: 70,
  });
  const r = runEngine(p, benefits, fpl, NOW);
  console.log("\n== Case 7: elderly refugee SSI ==");
  check("ssi", statusOf(r, "ssi"), "likely_eligible");
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
