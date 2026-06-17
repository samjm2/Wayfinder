// ── Immigration status enum (matches eligibility-schema.js) ──────────────────
export type ImmigrationStatus =
  | "refugee_207"
  | "asylee_208"
  | "siv"
  | "afghan_parolee"
  | "ukrainian_parolee"
  | "cuban_haitian_entrant"
  | "trafficking_victim"
  | "amerasian"
  | "lpr_from_humanitarian"
  | "lpr_other"
  | "us_citizen"
  | "other_none";

export type EmploymentStatus =
  | "employed_full_time"
  | "employed_part_time"
  | "unemployed_looking"
  | "unemployed_not_looking"
  | "unable_to_work";

export type HousingSituation =
  | "with_sponsor"
  | "temporary"
  | "unhoused"
  | "renting"
  | "other";

export type BenefitStatus =
  | "likely_eligible"
  | "maybe_eligible"
  | "not_eligible"
  | "needs_human_review";

export type ProgressStatus =
  | "not_started"
  | "in_progress"
  | "documents_ready"
  | "submitted"
  | "needs_attorney"
  | "done";

// ── Profile — 24 user-input fields + metadata ────────────────────────────────
export interface Profile {
  id: string;
  email: string | null;
  language_code: string;

  // Part A — Immigration / Identity
  immigration_status: ImmigrationStatus | null;
  has_i94: boolean | null;
  has_ead: boolean | null;
  has_ssn: boolean | null;
  has_orr_eligibility_letter: boolean | null;

  // Part A — Key Dates
  eligibility_date: string | null;      // ORR eligibility date (arrival or status-grant)
  arrival_date: string | null;
  status_grant_date: string | null;

  // Part A — Location
  state: string | null;
  city: string | null;
  zip_code: string | null;

  // Part A — Household / Income
  age: number | null;
  household_size: number | null;
  household_gross_monthly_income: number | null;
  num_children_under_19: number | null;
  num_children_under_18: number | null;
  num_children_under_5: number | null;
  is_pregnant: boolean | null;
  receives_other_cash_benefit: boolean | null;

  // Part A — Special Circumstances
  is_unaccompanied_minor: boolean | null;
  is_disabled: boolean | null;
  is_blind: boolean | null;
  has_40_work_quarters: boolean | null;

  // Part A — Goals / Services
  is_employed_or_seeking: boolean | null;
  wants_to_start_business: boolean | null;
  wants_english_classes: boolean | null;
  needs_interpreter: boolean | null;

  // Meta
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
}

// ── Derived fields computed by the eligibility engine ────────────────────────
export interface DerivedFields {
  is_orr_eligible_population: boolean;
  is_qualified_alien: boolean;
  has_adjusted_to_lpr: boolean;
  eligibility_date_on_or_after_may5_2025: boolean;
  months_since_eligibility_date: number | null;
  months_since_arrival: number | null;
  years_since_status_grant: number | null;
  percent_fpl: number | null;          // household income as % of FPL
}

// ── Eligibility result types ──────────────────────────────────────────────────
export interface EligibilityDeadline {
  label: string;
  daysLeft: number | null;
  deadlineDate: string | null;
}

export interface EligibilitySource {
  title: string;
  url: string;
  rowId: string;
}

export interface EligibilityBenefit {
  id: string;
  name: string;
  status: BenefitStatus;
  whyPlainLanguage: string;
  deadline: EligibilityDeadline;
  requiredDocuments: string[];
  nextSteps: string[];
  applicationLink: string;
  administeringAgency: string;
  needsAttorney: boolean;
  sources: EligibilitySource[];
  verificationNote: string;
}

export interface FlaggedForHuman {
  id: string;
  reason: string;
}

export interface EligibilityResult {
  id: string;
  userId: string;
  generatedAt: string;
  language: string;
  rulesLastChecked: string;
  summary: string;
  attorneyNeeded: boolean;
  benefits: EligibilityBenefit[];
  flaggedForHuman: FlaggedForHuman[];
}

export interface Document {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  document_type: string | null;
  extracted_fields: Record<string, string> | null;
  uploaded_at: string;
}

export interface BenefitProgress {
  id: string;
  user_id: string;
  benefit_id: string;
  benefit_name: string;
  status: ProgressStatus;
  notes: string | null;
  updated_at: string;
}

// ── Benefit database record (database/benefits.json shape) ───────────────────
export interface BenefitSource {
  title: string;
  url: string;
  asOf: string;
}

export interface BenefitRecord {
  id: string;
  name: string;
  category: string;
  agency: string;
  description: string;
  benefits: string;
  eligibility_text: string;
  rule: Rule;
  time_limit: string;
  how_to_apply: string;
  apply_link: string;
  form: string;
  restore_if_lost: string;
  current_status_note: string;
  sources: BenefitSource[];
}

// ── Machine-evaluable rule tree (database/eligibility-schema.js operators) ────
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | {
      var: string;
      is?: boolean;
      eq?: unknown;
      in?: unknown[];
      lte?: number;
      gte?: number;
      lt?: number;
      gt?: number;
      review?: boolean;
    }
  | { fpl: number; of: string; size: string; review?: boolean };

export interface EligibilityRule {
  rowId: string;
  benefitName: string;
  shortDescription: string;
  eligiblePopulations: string[];
  otherCriteria: string;
  timeWindow: string;
  requiredDocuments: string[];
  administeringAgency: string;
  howToApply: string;
  applicationLink: string;
  states: string | string[];
  needsAttorney: boolean;
  officialSourceURL: string;
  lastVerifiedDate: string;
}
