import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getClaudeClient, SONNET } from "@/lib/claude";
import { readFileSync } from "fs";
import { join } from "path";
import type { BenefitRecord, BenefitVerification, EligibilityBenefit, Profile } from "@/lib/types";
import { computeDerived, type FPLTable } from "@/lib/eligibility/derive";
import { evaluateAll } from "@/lib/eligibility/engine";
import { verifyNarratives, type VerificationOutcome } from "@/lib/eligibility/verifyResult";

// ── Load static data files ────────────────────────────────────────────────────

function loadBenefits(): BenefitRecord[] {
  return JSON.parse(readFileSync(join(process.cwd(), "database", "benefits.json"), "utf8"));
}

function loadFPL(): FPLTable {
  return JSON.parse(readFileSync(join(process.cwd(), "data", "fpl_2025.json"), "utf8"));
}

// ── Robust JSON extraction (never throws) ─────────────────────────────────────

function extractJson(text: string): unknown | null {
  if (!text) return null;
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // Fast path: first { ... last } (or [ ... ]).
  const firstObj = text.indexOf("{");
  const lastObj = text.lastIndexOf("}");
  const firstArr = text.indexOf("[");
  const lastArr = text.lastIndexOf("]");

  if (firstObj !== -1 && lastObj > firstObj) {
    const r = tryParse(text.slice(firstObj, lastObj + 1));
    if (r !== null) return r;
  }
  if (firstArr !== -1 && lastArr > firstArr) {
    const r = tryParse(text.slice(firstArr, lastArr + 1));
    if (r !== null) return r;
  }

  // Balanced-brace scan from the first opening brace.
  const start = firstObj !== -1 ? firstObj : firstArr;
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const r = tryParse(text.slice(start, i + 1));
        if (r !== null) return r;
      }
    }
  }
  return null;
}

// ── Claude narrative generation (text only; never decides eligibility) ───────

interface Narratives {
  summary: string;
  // The deterministic, source-derived fallback summary — used as the VERIFIED
  // replacement if the verification pass can't confirm the generated summary.
  templateSummary: string;
  perBenefit: Record<string, { whyPlainLanguage: string; nextSteps: string[] }>;
}

async function generateNarratives(
  client: ReturnType<typeof getClaudeClient>,
  benefits: EligibilityBenefit[],
  profile: Profile,
  language: string,
  attorneyNeeded: boolean
): Promise<Narratives> {
  // Only narrate benefits the user might pursue.
  const relevant = benefits.filter((b) => b.status !== "not_eligible");

  // Template summary used as the fallback (and seed for empty cases).
  const names = relevant.map((b) => b.name).slice(0, 8).join(", ");
  const templateSummary = relevant.length
    ? `You may qualify for: ${names}.${
        attorneyNeeded ? " Some items need a lawyer's help — we'll connect you." : ""
      }`
    : "We could not confirm any programs yet. A caseworker can help review your situation.";

  // Pre-seed perBenefit from the existing English template text so a Claude
  // failure degrades gracefully (never to empty).
  const perBenefit: Record<string, { whyPlainLanguage: string; nextSteps: string[] }> = {};
  for (const b of relevant) {
    perBenefit[b.id] = { whyPlainLanguage: b.whyPlainLanguage, nextSteps: b.nextSteps };
  }

  if (relevant.length === 0) {
    return { summary: templateSummary, templateSummary, perBenefit };
  }

  try {
    const compact = relevant.map((b) => {
      const src = benefits.find((x) => x.id === b.id);
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        agency: b.administeringAgency,
        description: src?.whyPlainLanguage ?? b.whyPlainLanguage,
      };
    });

    const count = relevant.length;
    const maxTokens = Math.min(16000, 4096 + 220 * count);

    const response = await client.messages.create({
      model: SONNET,
      max_tokens: maxTokens,
      system: `Return ONLY a JSON object {summary, items:[{id, why, steps:[...]}]} in language ${language}. why<=2 sentences, steps<=4 short imperative items. Do not change any eligibility status. Do not invent programs.`,
      messages: [
        {
          role: "user",
          content: `Language: ${language}
Attorney needed overall: ${attorneyNeeded}
Programs to describe (write a warm 2-3 sentence summary addressed to "you", then why+steps per program):
${JSON.stringify(compact)}`,
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = extractJson(text) as
      | { summary?: string; items?: { id: string; why?: string; steps?: string[] }[] }
      | null;

    if (!parsed) {
      return { summary: templateSummary, templateSummary, perBenefit };
    }

    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : templateSummary;

    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        if (!item || typeof item.id !== "string" || !perBenefit[item.id]) continue;
        const why = typeof item.why === "string" && item.why.trim() ? item.why.trim() : undefined;
        const steps =
          Array.isArray(item.steps) && item.steps.length
            ? item.steps.filter((s) => typeof s === "string" && s.trim()).slice(0, 4)
            : undefined;
        perBenefit[item.id] = {
          whyPlainLanguage: why ?? perBenefit[item.id].whyPlainLanguage,
          nextSteps: steps ?? perBenefit[item.id].nextSteps,
        };
      }
    }

    return { summary, templateSummary, perBenefit };
  } catch {
    // Claude outage / error -> English templates. Never empty.
    return { summary: templateSummary, templateSummary, perBenefit };
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  const benefits = loadBenefits();
  const fpl = loadFPL();
  const now = new Date();
  const derived = computeDerived(profile as Profile, fpl, now);
  const language = profile.language_code ?? "en";

  // ── Deterministic engine: statuses, deadlines, docs, sources, links ──
  const baseBenefits = evaluateAll(profile as Profile, derived, benefits, fpl, now);

  const attorneyNeeded = baseBenefits.some(
    (b) => b.needsAttorney && b.status !== "not_eligible"
  );

  // ── Claude: narrative text ONLY (robust, fallback-safe) ──
  const claude = getClaudeClient();
  let summary = "";
  let templateSummary = "";
  let narratedBenefits = baseBenefits;
  try {
    const narratives = await generateNarratives(
      claude,
      baseBenefits,
      profile as Profile,
      language,
      attorneyNeeded
    );
    summary = narratives.summary;
    templateSummary = narratives.templateSummary;
    narratedBenefits = baseBenefits.map((b) => {
      const n = narratives.perBenefit[b.id];
      if (!n) return b;
      // Merge ONLY why/steps. Never touch status, needsAttorney, deadline, etc.
      return { ...b, whyPlainLanguage: n.whyPlainLanguage, nextSteps: n.nextSteps };
    });
  } catch {
    // Defensive: even generateNarratives' internal try/catch shouldn't reach
    // here, but never fail the request over narrative text.
    const names = baseBenefits
      .filter((b) => b.status !== "not_eligible")
      .map((b) => b.name)
      .slice(0, 8)
      .join(", ");
    summary = names ? `You may qualify for: ${names}.` : "";
    templateSummary = summary;
  }

  // ── Independent verification pass ────────────────────────────────────────────
  // A SEPARATE Claude call audits the generated why/steps/summary against the
  // curated source records (database/benefits.json). It does NOT re-decide
  // eligibility — only faithfulness. Anything it can't verify is dropped (replaced
  // with the verified source template) or flagged before display; if the verifier
  // itself fails we fail safe by treating everything as unverified.
  const flaggedForHuman: { id: string; reason: string }[] = [];
  {
    const relevant = narratedBenefits.filter((b) => b.status !== "not_eligible");
    let verification: VerificationOutcome | null = null;
    try {
      verification = await verifyNarratives(claude, relevant, benefits, summary);
    } catch {
      verification = null;
    }

    const byBase = new Map(baseBenefits.map((b) => [b.id, b]));
    narratedBenefits = narratedBenefits.map((b) => {
      if (b.status === "not_eligible") return b;
      const base = byBase.get(b.id);
      const v = verification?.ok ? verification.perBenefit[b.id] : undefined;

      // Verifier failed or said nothing about this program → fail safe: show only
      // the verified source template, flagged for review.
      if (!v) {
        const failVerification: BenefitVerification = {
          status: "flagged",
          claims: [
            {
              field: "why",
              text: b.whyPlainLanguage,
              verdict: "unverifiable",
              reason: "Verification could not be completed.",
            },
          ],
        };
        return {
          ...b,
          whyPlainLanguage: base?.whyPlainLanguage ?? b.whyPlainLanguage,
          nextSteps: base?.nextSteps ?? b.nextSteps,
          verification: failVerification,
        };
      }

      // Show the generated "why" only if it verified; otherwise revert to the
      // verified source template (never display an unverified description).
      const whyClaim = v.claims.find((c) => c.field === "why");
      const whyPlainLanguage =
        whyClaim?.verdict === "verified"
          ? b.whyPlainLanguage
          : base?.whyPlainLanguage ?? b.whyPlainLanguage;

      // Keep only verified steps; if none survive, revert to the source template.
      const keptSteps = b.nextSteps.filter((_, i) => {
        const c = v.claims.find((cl) => cl.field === "step" && cl.index === i);
        return c?.verdict === "verified";
      });
      const nextSteps = keptSteps.length ? keptSteps : base?.nextSteps ?? b.nextSteps;

      return { ...b, whyPlainLanguage, nextSteps, verification: v };
    });

    // Summary: keep the generated one only if it verified; else the safe template.
    if (!verification?.ok || verification.summaryStatus !== "verified") {
      summary = templateSummary || summary;
    }

    // Queue every flagged program for human review.
    for (const b of narratedBenefits) {
      if (b.status !== "not_eligible" && b.verification?.status === "flagged") {
        const reason = b.verification.claims
          .filter((c) => c.verdict !== "verified")
          .map((c) => `${c.field}${c.index != null ? ` #${c.index + 1}` : ""}: ${c.reason || c.verdict}`)
          .join("; ");
        flaggedForHuman.push({
          id: b.id,
          reason: reason || "Some details could not be verified against the source record.",
        });
      }
    }
  }

  // ── Rank: soonest deadline first (nulls last), then status ──
  const statusRank: Record<string, number> = {
    likely_eligible: 0,
    not_eligible: 1,
  };
  narratedBenefits.sort((a, b) => {
    if (a.deadline.daysLeft !== null && b.deadline.daysLeft !== null)
      return a.deadline.daysLeft - b.deadline.daysLeft;
    if (a.deadline.daysLeft !== null) return -1;
    if (b.deadline.daysLeft !== null) return 1;
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
  });

  // ── Last verified date from benefits database ──
  const allDates = benefits
    .flatMap((b) => (b.sources ?? []).map((s) => s.asOf ?? ""))
    .filter(Boolean)
    .sort()
    .reverse();
  const rulesLastChecked = allDates[0] ?? now.toISOString().split("T")[0];

  // ── Persist results + seed progress (service client bypasses RLS) ──
  const serviceClient = await createServiceClient();

  // Seed benefit_progress: one row per eligible (likely/maybe/review) benefit.
  const eligible = narratedBenefits.filter((b) => b.status !== "not_eligible");
  const progressRows = eligible.map((b) => ({
    user_id: user.id,
    benefit_id: b.id,
    benefit_name: b.name,
    status: b.needsAttorney ? "needs_attorney" : "not_started",
  }));
  if (progressRows.length > 0) {
    const { error: progressError } = await serviceClient
      .from("benefit_progress")
      .upsert(progressRows, { onConflict: "user_id,benefit_id" });
    if (progressError) {
      // Log but do not fail the request — results still return.
      console.error("benefit_progress seed error:", progressError.message);
    }
  }

  const { data: saved, error } = await serviceClient
    .from("eligibility_results")
    .insert({
      user_id: user.id,
      generated_at: now.toISOString(),
      language,
      rules_last_checked: rulesLastChecked,
      summary,
      attorney_needed: attorneyNeeded,
      benefits: narratedBenefits,
      flagged_for_human: flaggedForHuman,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, resultId: saved.id });
}
