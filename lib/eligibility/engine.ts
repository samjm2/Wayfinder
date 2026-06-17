// Deterministic eligibility rule engine.
// PURE: no React, no DB, no Claude, no fs. Given a profile, derived fields, the
// benefits database and the FPL table, it evaluates each benefit's machine-
// evaluable `rule` tree and produces EligibilityBenefit records with template
// (English) narrative text — to be optionally overwritten by Claude later.
//
// Core safety property: MISSING input never produces "not_eligible". Unknown
// answers resolve to "review" (-> needs_human_review), so incomplete data can
// never silently tell a refugee they qualify for nothing.

import type {
  BenefitRecord,
  BenefitStatus,
  EligibilityBenefit,
  Profile,
  Rule,
} from "@/lib/types";
import {
  computeDerived,
  percentFPL,
  type EngineDerivedFields,
  type FPLTable,
} from "@/lib/eligibility/derive";

export type RuleResult = "pass" | "fail" | "review";

export interface EvalContext {
  profile: Profile;
  derived: EngineDerivedFields;
  fpl: FPLTable;
  now: Date;
  // Mutable flag: set true whenever an fpl leaf could not be evaluated because
  // percent_fpl is unknown (income/size not provided). Lets evaluateBenefit
  // downgrade an otherwise-passing benefit to "maybe_eligible".
  unresolvedIncome: boolean;
}

// The 11 derived keys that take precedence over raw profile fields.
const DERIVED_KEYS = new Set<string>([
  "is_orr_eligible_population",
  "is_qualified_alien",
  "has_adjusted_to_lpr",
  "eligibility_date_on_or_after_may5_2025",
  "months_since_eligibility_date",
  "months_since_arrival",
  "years_since_status_grant",
  "percent_fpl",
  "eligible_for_tanf",
  "eligible_for_ssi",
  "eligible_for_medicaid",
]);

// Numeric profile fields that should coerce via Number().
const NUMERIC_PROFILE_KEYS = new Set<string>([
  "age",
  "household_size",
  "household_gross_monthly_income",
  "num_children_under_19",
  "num_children_under_18",
  "num_children_under_5",
]);

// ── Variable resolution ──────────────────────────────────────────────────────

export function resolveVar(name: string, ctx: EvalContext): unknown {
  if (DERIVED_KEYS.has(name)) {
    const v = (ctx.derived as unknown as Record<string, unknown>)[name];
    return v === null || v === undefined ? undefined : v;
  }
  const raw = (ctx.profile as unknown as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return undefined;
  if (NUMERIC_PROFILE_KEYS.has(name)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return raw;
}

// ── Leaf detection ───────────────────────────────────────────────────────────

type VarLeaf = Extract<Rule, { var: string }>;
type FplLeaf = Extract<Rule, { fpl: number }>;

function isAll(r: Rule): r is { all: Rule[] } {
  return Array.isArray((r as { all?: unknown }).all);
}
function isAny(r: Rule): r is { any: Rule[] } {
  return Array.isArray((r as { any?: unknown }).any);
}
function isNot(r: Rule): r is { not: Rule } {
  return (r as { not?: unknown }).not !== undefined;
}
function isVarLeaf(r: Rule): r is VarLeaf {
  return typeof (r as { var?: unknown }).var === "string";
}
function isFplLeaf(r: Rule): r is FplLeaf {
  return typeof (r as { fpl?: unknown }).fpl === "number";
}

// ── Leaf evaluation (three-valued) ───────────────────────────────────────────

function evalVarLeaf(leaf: VarLeaf, ctx: EvalContext): RuleResult {
  const value = resolveVar(leaf.var, ctx);
  // Missing input -> review (never fail). Core safety property.
  if (value === undefined) return "review";

  let cmp: boolean;
  if (leaf.is !== undefined) {
    cmp = Boolean(value) === leaf.is;
  } else if (leaf.eq !== undefined) {
    cmp = value === leaf.eq;
  } else if (leaf.in !== undefined) {
    cmp = leaf.in.includes(value);
  } else if (
    leaf.lte !== undefined ||
    leaf.gte !== undefined ||
    leaf.lt !== undefined ||
    leaf.gt !== undefined
  ) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "review";
    if (leaf.lte !== undefined) cmp = n <= leaf.lte;
    else if (leaf.gte !== undefined) cmp = n >= leaf.gte;
    else if (leaf.lt !== undefined) cmp = n < leaf.lt;
    else cmp = n > (leaf.gt as number);
  } else {
    // Unknown operator — be safe.
    return "review";
  }

  if (cmp) return leaf.review === true ? "review" : "pass";
  return "fail";
}

function evalFplLeaf(leaf: FplLeaf, ctx: EvalContext): RuleResult {
  // Prefer the already-computed derived.percent_fpl; otherwise recompute from
  // the named income/size variables.
  let pct = ctx.derived.percent_fpl;
  if (pct === null || pct === undefined) {
    const income = resolveVar(leaf.of, ctx);
    const size = resolveVar(leaf.size, ctx);
    if (
      typeof income === "number" &&
      Number.isFinite(income) &&
      typeof size === "number" &&
      Number.isFinite(size) &&
      size > 0
    ) {
      pct = percentFPL(income, size, ctx.fpl);
    }
  }
  // Missing income/size -> the income test cannot be applied. Treat
  // permissively (pass) but flag it, so evaluateBenefit can downgrade an
  // otherwise-passing benefit to "maybe_eligible" (show it, but soft).
  if (pct === null || pct === undefined) {
    ctx.unresolvedIncome = true;
    return leaf.review === true ? "review" : "pass";
  }
  const cmp = pct <= leaf.fpl;
  if (cmp) return leaf.review === true ? "review" : "pass";
  return "fail";
}

// ── Rule tree evaluation (three-valued combinators) ──────────────────────────

export function evalRule(rule: Rule, ctx: EvalContext): RuleResult {
  if (isAll(rule)) {
    const results = rule.all.map((c) => evalRule(c, ctx));
    if (results.some((r) => r === "fail")) return "fail";
    if (results.some((r) => r === "review")) return "review";
    return "pass";
  }
  if (isAny(rule)) {
    const results = rule.any.map((c) => evalRule(c, ctx));
    if (results.some((r) => r === "pass")) return "pass";
    if (results.some((r) => r === "review")) return "review";
    return "fail";
  }
  if (isNot(rule)) {
    const r = evalRule(rule.not, ctx);
    if (r === "pass") return "fail";
    if (r === "fail") return "pass";
    return "review";
  }
  if (isFplLeaf(rule)) return evalFplLeaf(rule, ctx);
  if (isVarLeaf(rule)) return evalVarLeaf(rule, ctx);
  // Unknown node — be safe.
  return "review";
}

// Does this rule tree contain any fpl leaf? (Used for the maybe_eligible
// downgrade when income could not be applied.)
function ruleHasFplLeaf(rule: Rule): boolean {
  if (isAll(rule)) return rule.all.some(ruleHasFplLeaf);
  if (isAny(rule)) return rule.any.some(ruleHasFplLeaf);
  if (isNot(rule)) return ruleHasFplLeaf(rule.not);
  return isFplLeaf(rule);
}

// ── needsAttorney (deterministic, from category) ─────────────────────────────

export function benefitNeedsAttorney(benefit: BenefitRecord): boolean {
  return benefit.category === "Legal / status";
}

// ── Benefit status mapping ───────────────────────────────────────────────────

export function evaluateBenefit(benefit: BenefitRecord, ctx: EvalContext): BenefitStatus {
  ctx.unresolvedIncome = false;
  const needsAttorney = benefitNeedsAttorney(benefit);
  const result = evalRule(benefit.rule, ctx);

  if (needsAttorney) {
    // Legal/status matters always route to a human unless clearly excluded.
    return result === "fail" ? "not_eligible" : "needs_human_review";
  }

  if (result === "fail") return "not_eligible";
  if (result === "review") return "needs_human_review";

  // result === "pass": downgrade to maybe_eligible when the income test could
  // not actually be applied (percent_fpl unknown) but the rule contains an fpl
  // leaf — the pass relied on the permissive "unknown income passes" default.
  if (ctx.derived.percent_fpl === null && ctx.unresolvedIncome && ruleHasFplLeaf(benefit.rule)) {
    return "maybe_eligible";
  }
  return "likely_eligible";
}

// ── Deadline computation ─────────────────────────────────────────────────────

export function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + n);
  return d;
}

interface DeadlineShape {
  label: string;
  daysLeft: number | null;
  deadlineDate: string | null;
}

function dayDiff(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / 86400000);
}

// Build a deadline from a base date + window in months. Honors the
// "window may have passed" rule: negative daysLeft -> null + that label.
function windowDeadline(
  baseStr: string | null,
  windowMonths: number,
  label: string,
  now: Date
): DeadlineShape {
  if (!baseStr) return { label, daysLeft: null, deadlineDate: null };
  const base = new Date(baseStr);
  if (isNaN(base.getTime())) return { label, daysLeft: null, deadlineDate: null };
  const deadlineDate = addMonths(base, windowMonths);
  const daysLeft = dayDiff(deadlineDate, now);
  if (daysLeft < 0) {
    return { label: "Window may have passed", daysLeft: null, deadlineDate: deadlineDate.toISOString().split("T")[0] };
  }
  return { label, daysLeft, deadlineDate: deadlineDate.toISOString().split("T")[0] };
}

function hardDateDeadline(dateStr: string, label: string, now: Date): DeadlineShape {
  const d = new Date(dateStr);
  const daysLeft = dayDiff(d, now);
  if (daysLeft < 0) {
    return { label: "Window may have passed", daysLeft: null, deadlineDate: dateStr };
  }
  return { label, daysLeft, deadlineDate: dateStr };
}

const SIXTY_MONTH_FROM_ARRIVAL = new Set<string>([
  "rss",
  "childcare_ccdf",
  "refugee_career_pathways",
  "ida",
  "preferred_communities",
]);

function computeDeadline(benefit: BenefitRecord, derived: EngineDerivedFields, ctx: EvalContext, now: Date): DeadlineShape {
  const id = benefit.id;
  const profile = ctx.profile;

  switch (id) {
    case "rca":
    case "rma": {
      const window = derived.eligibility_date_on_or_after_may5_2025 ? 4 : 12;
      return windowDeadline(
        profile.eligibility_date,
        window,
        `Apply within ${window} months of your eligibility date`,
        now
      );
    }
    case "matching_grant":
      return windowDeadline(
        profile.eligibility_date,
        1,
        "Apply within 1 month of your eligibility date",
        now
      );
    case "reception_placement":
      return windowDeadline(
        profile.arrival_date,
        3,
        "Available in your first 3 months after arrival",
        now
      );
    case "medical_screening":
      return windowDeadline(
        profile.arrival_date,
        12,
        "Recommended within 12 months of arrival",
        now
      );
    case "ssi":
      return windowDeadline(
        profile.status_grant_date,
        84,
        "Eligibility ends 7 years after your status was granted",
        now
      );
    case "medicaid":
    case "chip":
      return hardDateDeadline(
        "2026-10-01",
        "Federal eligibility for many statuses ends October 1, 2026",
        now
      );
    case "aca_marketplace":
      return hardDateDeadline(
        "2027-01-01",
        "Subsidy eligibility for refugees/asylees ends January 1, 2027",
        now
      );
    default:
      if (SIXTY_MONTH_FROM_ARRIVAL.has(id)) {
        return windowDeadline(
          profile.arrival_date,
          60,
          "Available up to 5 years (60 months) from arrival",
          now
        );
      }
      // No time component.
      return {
        label: benefit.time_limit?.trim() ? benefit.time_limit : "No specific deadline",
        daysLeft: null,
        deadlineDate: null,
      };
  }
}

// ── Required documents (template, per-category + generic) ────────────────────

const GENERIC_STATUS_DOCS = [
  "Proof of immigration status (I-94 / EAD)",
  "Photo ID",
];

const CATEGORY_DOCS: Record<string, string[]> = {
  "Cash assistance": ["Proof of income (or statement of no income)", "Proof of address"],
  "Health coverage": ["Proof of income", "Proof of address"],
  "Food assistance": ["Proof of income", "Proof of household size", "Proof of address"],
  "Disability / elderly cash": ["Proof of income", "Medical records (if disabled/blind)"],
  "Energy & housing": ["Proof of income", "Proof of address", "Utility bill (if applicable)"],
  "Employment & integration": ["Proof of address"],
  "Legal / status": ["Any prior immigration paperwork", "I-94 / approval notices"],
};

function requiredDocumentsFor(benefit: BenefitRecord, ctx: EvalContext): string[] {
  const docs = [...GENERIC_STATUS_DOCS, ...(CATEGORY_DOCS[benefit.category] ?? [])];
  // Trafficking victims use an ORR certification/eligibility letter (not an
  // I-94) to access ORR-funded programs.
  if (ctx.profile.immigration_status === "trafficking_victim") {
    docs.push("ORR eligibility / certification letter");
  }
  return docs;
}

// ── Narrative templates (English; overwritten by Claude when available) ──────

function splitSteps(howToApply: string): string[] {
  if (!howToApply) return [];
  // Split on sentence boundaries / semicolons into short imperative-ish items.
  return howToApply
    .split(/(?<=[.;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 4);
}

// ── Field mapping benefits.json -> EligibilityBenefit ────────────────────────

export function toEligibilityBenefit(
  benefit: BenefitRecord,
  status: BenefitStatus,
  ctx: EvalContext,
  now: Date
): EligibilityBenefit {
  const needsAttorney = benefitNeedsAttorney(benefit);
  const why = [benefit.description, benefit.eligibility_text].filter(Boolean).join(" ").trim();

  return {
    id: benefit.id,
    name: benefit.name,
    status,
    whyPlainLanguage: why,
    deadline: computeDeadline(benefit, ctx.derived, ctx, now),
    requiredDocuments: requiredDocumentsFor(benefit, ctx),
    nextSteps: splitSteps(benefit.how_to_apply),
    applicationLink: benefit.apply_link ?? "",
    administeringAgency: benefit.agency ?? "",
    needsAttorney,
    sources: (benefit.sources ?? []).map((s) => ({
      title: s.title,
      url: s.url,
      rowId: benefit.id,
    })),
    verificationNote: "",
  };
}

// ── Top-level: evaluate every benefit ────────────────────────────────────────

export function evaluateAll(
  profile: Profile,
  derived: EngineDerivedFields,
  benefits: BenefitRecord[],
  fpl: FPLTable,
  now: Date
): EligibilityBenefit[] {
  const ctx: EvalContext = { profile, derived, fpl, now, unresolvedIncome: false };
  return benefits.map((benefit) => {
    const status = evaluateBenefit(benefit, ctx);
    return toEligibilityBenefit(benefit, status, ctx, now);
  });
}

// Convenience: compute derived + evaluate in one call (used by tests).
export function runEngine(
  profile: Profile,
  benefits: BenefitRecord[],
  fpl: FPLTable,
  now: Date = new Date()
): EligibilityBenefit[] {
  const derived = computeDerived(profile, fpl, now);
  return evaluateAll(profile, derived, benefits, fpl, now);
}
