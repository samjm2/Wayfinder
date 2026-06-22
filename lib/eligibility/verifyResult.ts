// ─────────────────────────────────────────────────────────────────────────────
// Independent action-plan verification pass.
//
// After the rules engine decides eligibility and a FIRST Claude call writes each
// qualified program up into plain-language, translated text (the "why" sentence
// and the next-steps), this runs a SECOND, independent Claude call that audits
// every factual claim in that generated text against the curated source record
// (database/benefits.json: official name, deadline/window, how-to-apply,
// required documents, citations).
//
// It does NOT re-decide eligibility — the engine already did that. It only checks
// whether the description faithfully matches the verified record, per claim.
//
// SAFETY CONTRACT (enforced here + by the caller):
//   • Every claim defaults to "unverifiable" unless the model explicitly says
//     "verified" — a missing/garbled verdict is NEVER treated as verified.
//   • If the call errors or returns nothing usable, we fail safe: every claim is
//     flagged so the caller can drop/replace it. We never pass unverified text
//     through as if it were checked.
//   • This is a SEPARATE messages.create call from the generator, so the check is
//     genuinely independent.
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from "@anthropic-ai/sdk";
import { SONNET } from "@/lib/claude";
import type {
  BenefitRecord,
  BenefitVerification,
  EligibilityBenefit,
  VerificationVerdict,
  VerifiedClaim,
} from "@/lib/types";

export interface VerificationOutcome {
  // false when the verifier call/parse failed — caller must fail safe.
  ok: boolean;
  perBenefit: Record<string, BenefitVerification>;
  summaryStatus: "verified" | "flagged";
}

const VERIFY_SYSTEM = `You are an INDEPENDENT fact-checker for a U.S. benefits navigator.

You are given, as JSON: a warm "summary", the list of valid "program_names", and an array of "programs". For each program you get the GENERATED text another step produced — a "generated_why" sentence and a "generated_steps" list — plus the VERIFIED "source" record for that program (official name, deadline_window, how_to_apply, required_documents, eligibility, benefits, restore_if_lost, citations).

Your ONLY job is to check whether each claim in the GENERATED text is faithful to that program's SOURCE record. You do NOT decide eligibility — assume every listed program is correctly qualified. You do NOT add or look up any outside information.

For EACH program, judge the "why" sentence and EACH step (by its 0-based index):
- "verified": the source clearly supports the claim.
- "flagged": the source CONTRADICTS the claim — e.g. a different deadline/time window, a required document the source does not list, a form/where-to-apply that conflicts with how_to_apply, or a wrong program name.
- "unverifiable": the source does not contain enough to confirm the claim (neither supported nor contradicted).
Be strict, especially about deadlines/time windows, required documents, forms, and where/how to apply: a specific deadline, document, form, or instruction that is NOT in the source is "flagged" if it conflicts, otherwise "unverifiable". Generic encouragement that invents no facts is "verified".

Also judge the "summary": "flagged" if it names any program not in program_names or states a benefit-wide fact that conflicts with the records; otherwise "verified".

Give a SHORT reason (<= 12 words) for anything that is not "verified".

Output ONLY valid JSON, no prose, no code fences, exactly:
{"benefits":[{"id":"<id>","why":{"verdict":"verified|flagged|unverifiable","reason":""},"steps":[{"index":0,"verdict":"verified|flagged|unverifiable","reason":""}]}],"summary":{"verdict":"verified|flagged|unverifiable","reason":""}}
Return one entry for every program id you were given.`;

// Robust JSON extraction — never throws, tolerates code fences / stray prose.
function extractJson(text: string): unknown | null {
  if (!text) return null;
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const firstObj = text.indexOf("{");
  const lastObj = text.lastIndexOf("}");
  if (firstObj !== -1 && lastObj > firstObj) {
    const r = tryParse(text.slice(firstObj, lastObj + 1));
    if (r !== null) return r;
  }
  // Balanced-brace scan from the first opening brace.
  if (firstObj === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = firstObj; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const r = tryParse(text.slice(firstObj, i + 1));
        if (r !== null) return r;
      }
    }
  }
  return null;
}

// Default to "unverifiable" for anything that isn't an explicit, recognized
// verdict — a missing/garbled value must NEVER read as "verified".
function normVerdict(v: unknown): VerificationVerdict {
  if (v === "verified" || v === "flagged" || v === "unverifiable") return v;
  return "unverifiable";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}

// Build a fully-flagged outcome (every claim unverifiable) — the fail-safe shape
// used when the verifier call errors or returns nothing usable.
function failSafe(narrated: EligibilityBenefit[], reason: string): VerificationOutcome {
  const perBenefit: Record<string, BenefitVerification> = {};
  for (const b of narrated) {
    const claims: VerifiedClaim[] = [
      { field: "why", text: b.whyPlainLanguage, verdict: "unverifiable", reason },
    ];
    b.nextSteps.forEach((s, i) =>
      claims.push({ field: "step", index: i, text: s, verdict: "unverifiable", reason }),
    );
    perBenefit[b.id] = { status: "flagged", claims };
  }
  return { ok: false, perBenefit, summaryStatus: "flagged" };
}

/**
 * Independently verify the generated action-plan text against the source records.
 * `narrated` must already be filtered to the benefits actually shown (status !==
 * "not_eligible"). Always resolves — never throws — so the caller can apply its
 * drop/flag policy uniformly.
 */
export async function verifyNarratives(
  client: Anthropic,
  narrated: EligibilityBenefit[],
  sources: BenefitRecord[],
  summary: string,
): Promise<VerificationOutcome> {
  if (narrated.length === 0) {
    return { ok: true, perBenefit: {}, summaryStatus: "verified" };
  }

  const byId = new Map(sources.map((s) => [s.id, s]));
  const payload = {
    summary,
    program_names: narrated.map((b) => b.name),
    programs: narrated.map((b) => {
      const src = byId.get(b.id);
      return {
        id: b.id,
        generated_why: b.whyPlainLanguage,
        generated_steps: b.nextSteps,
        source: {
          name: src?.name ?? b.name,
          deadline_window: src?.time_limit ?? b.deadline.label ?? "",
          how_to_apply: src?.how_to_apply ?? "",
          required_documents: b.requiredDocuments,
          eligibility: src?.eligibility_text ?? "",
          benefits: src?.benefits ?? "",
          restore_if_lost: src?.restore_if_lost ?? "",
          citations: (src?.sources ?? []).map((s) => s.title),
        },
      };
    }),
  };

  try {
    const maxTokens = Math.min(16000, 2048 + 280 * narrated.length);
    const response = await client.messages.create({
      model: SONNET,
      max_tokens: maxTokens,
      system: VERIFY_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = extractJson(text) as
      | {
          benefits?: {
            id?: string;
            why?: { verdict?: unknown; reason?: unknown };
            steps?: { index?: unknown; verdict?: unknown; reason?: unknown }[];
          }[];
          summary?: { verdict?: unknown };
        }
      | null;

    if (!parsed || !Array.isArray(parsed.benefits)) {
      return failSafe(narrated, "Verifier returned no usable result.");
    }

    const resById = new Map(parsed.benefits.map((r) => [r?.id, r]));
    const perBenefit: Record<string, BenefitVerification> = {};

    for (const b of narrated) {
      const r = resById.get(b.id);
      const claims: VerifiedClaim[] = [];

      // "why" — defaults to unverifiable if the model omitted this program.
      claims.push({
        field: "why",
        text: b.whyPlainLanguage,
        verdict: normVerdict(r?.why?.verdict),
        reason: str(r?.why?.reason),
      });

      // Each step — match by the model's explicit index. Only fall back to
      // positional order when NO step carries an index (an ordered list); never
      // positionally when indices ARE present, so a malformed/duplicate-index
      // reply can't accidentally retain an unrated step (it defaults to
      // unverifiable → dropped).
      const stepResults = Array.isArray(r?.steps) ? r.steps : [];
      const indicesPresent = stepResults.some(
        (x) => x?.index != null && !Number.isNaN(Number(x.index)),
      );
      b.nextSteps.forEach((stepText, i) => {
        const sr = indicesPresent
          ? stepResults.find((x) => Number(x?.index) === i)
          : stepResults[i];
        claims.push({
          field: "step",
          index: i,
          text: stepText,
          verdict: normVerdict(sr?.verdict),
          reason: str(sr?.reason),
        });
      });

      const allVerified = claims.every((c) => c.verdict === "verified");
      perBenefit[b.id] = { status: allVerified ? "verified" : "flagged", claims };
    }

    const summaryStatus =
      normVerdict(parsed.summary?.verdict) === "verified" ? "verified" : "flagged";

    return { ok: true, perBenefit, summaryStatus };
  } catch {
    return failSafe(narrated, "Verification step could not run.");
  }
}
