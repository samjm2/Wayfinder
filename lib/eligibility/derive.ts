// Deterministic derived-field computation for the eligibility engine.
// PURE: no React, no DB, no Claude, no fs. Behavior is identical to the
// previous computeDerived in app/api/eligibility/route.ts (no math changes).

import type { DerivedFields, Profile } from "@/lib/types";

// The FPL table shape (data/fpl_2025.json). Loaded by the caller and passed in.
export interface FPLTable {
  monthly_by_household_size: Record<string, number>;
  monthly_each_additional: number;
  [key: string]: unknown;
}

// ── Status sets (moved verbatim from route.ts) ───────────────────────────────

export const ORR_ELIGIBLE_STATUSES = new Set<string>([
  "refugee_207", "asylee_208", "siv", "afghan_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
]);

export const QUALIFIED_ALIEN_STATUSES = new Set<string>([
  "refugee_207", "asylee_208", "siv", "afghan_parolee", "ukrainian_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
  "lpr_from_humanitarian", "lpr_other", "us_citizen",
]);

export const LPR_STATUSES = new Set<string>(["lpr_from_humanitarian", "lpr_other"]);

// ── FPL helpers ──────────────────────────────────────────────────────────────

export function getMonthlyFPL(householdSize: number, fpl: FPLTable): number {
  const size = Math.max(1, householdSize);
  if (size <= 8) return fpl.monthly_by_household_size[String(size)];
  return fpl.monthly_by_household_size["8"] + (size - 8) * fpl.monthly_each_additional;
}

export function percentFPL(monthlyIncome: number, householdSize: number, fpl: FPLTable): number {
  const base = getMonthlyFPL(householdSize, fpl);
  return base > 0 ? (monthlyIncome / base) * 100 : 0;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

export function monthsBetween(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

export function yearsBetween(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

// ── Extended derived fields ──────────────────────────────────────────────────
// DerivedFields (lib/types.ts) defines the 8 public fields. The engine also
// needs the three gating eligibility booleans, kept on this superset type.

export interface EngineDerivedFields extends DerivedFields {
  eligible_for_tanf: boolean;
  eligible_for_ssi: boolean;
  eligible_for_medicaid: boolean;
}

// computeDerived — IDENTICAL behavior to route.ts:75-125.
export function computeDerived(
  profile: Profile,
  fpl: FPLTable,
  now: Date = new Date()
): EngineDerivedFields {
  const status = profile.immigration_status ?? "other_none";
  const monthsEligibility = monthsBetween(profile.eligibility_date, now);
  const monthsArrival = monthsBetween(profile.arrival_date, now);
  const yearsStatus = yearsBetween(profile.status_grant_date, now);
  const pctFPL =
    profile.household_gross_monthly_income !== null && profile.household_size
      ? percentFPL(Number(profile.household_gross_monthly_income), profile.household_size, fpl)
      : null;

  const is_orr = ORR_ELIGIBLE_STATUSES.has(status);
  const is_qualified = QUALIFIED_ALIEN_STATUSES.has(status);
  const is_lpr = LPR_STATUSES.has(status);
  const elig_after_may5 = profile.eligibility_date
    ? new Date(profile.eligibility_date) >= new Date("2025-05-05")
    : false;

  const eligible_for_tanf = Boolean(
    (is_orr || is_lpr) &&
      Number(profile.num_children_under_19 ?? 0) > 0 &&
      (pctFPL === null || pctFPL <= 185)
  );

  const eligible_for_ssi = Boolean(
    (is_orr || is_qualified) &&
      (Number(profile.age ?? 0) >= 65 || profile.is_disabled || profile.is_blind) &&
      (yearsStatus === null || yearsStatus <= 7)
  );

  const eligible_for_medicaid = Boolean(
    is_qualified && (pctFPL === null || pctFPL <= 138)
  );

  return {
    is_orr_eligible_population: is_orr,
    is_qualified_alien: is_qualified,
    has_adjusted_to_lpr: is_lpr,
    eligibility_date_on_or_after_may5_2025: elig_after_may5,
    months_since_eligibility_date: monthsEligibility,
    months_since_arrival: monthsArrival,
    years_since_status_grant: yearsStatus,
    percent_fpl: pctFPL,
    eligible_for_tanf,
    eligible_for_ssi,
    eligible_for_medicaid,
  };
}
