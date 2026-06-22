// Translate the DISPLAY strings of a computed eligibility result into the user's
// language. The eligibility DECISION stays deterministic (engine.ts) — this only
// translates the human-readable text (benefit names, "why", deadline labels,
// required documents, next steps, and the summary) so the dashboard reads in the
// user's language. Server-only (uses the Claude client).
//
// Field names match what the eligibility route stores in eligibility_results.benefits.

import { getClaudeClient, SONNET } from "@/lib/claude";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

interface StoredBenefit {
  id: string;
  name?: string;
  whyPlainLanguage?: string;
  deadline?: { label?: string } & Record<string, unknown>;
  requiredDocuments?: string[];
  nextSteps?: string[];
  [k: string]: unknown;
}

export interface StoredResult {
  language?: string;
  summary?: string;
  benefits?: StoredBenefit[];
  [k: string]: unknown;
}

function extractJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Translate the result into targetLang. Returns the original unchanged on any
// failure (never throws). Translates the DISPLAY text only; ids/dates/links/status
// are untouched.
export async function translateEligibilityResult<T extends StoredResult>(
  result: T,
  targetLang: string,
): Promise<T> {
  if (!result || !Array.isArray(result.benefits) || result.benefits.length === 0) {
    return result;
  }
  const langName = SUPPORTED_LANGUAGES.find((l) => l.code === targetLang)?.name ?? targetLang;

  const payload = {
    summary: typeof result.summary === "string" ? result.summary : "",
    benefits: result.benefits.map((b) => ({
      id: b.id,
      name: b.name ?? "",
      why: b.whyPlainLanguage ?? "",
      deadlineLabel: b.deadline?.label ?? "",
      requiredDocuments: Array.isArray(b.requiredDocuments) ? b.requiredDocuments : [],
      nextSteps: Array.isArray(b.nextSteps) ? b.nextSteps : [],
    })),
  };

  try {
    const client = getClaudeClient();
    const resp = await client.messages.create({
      model: SONNET,
      max_tokens: 8000,
      system: `You translate a U.S. benefits result into ${langName} (language code ${targetLang}) for a refugee/immigrant reader.
- Translate ONLY the string values. Keep every JSON key, every "id", the nesting, and every array's length identical.
- Keep program acronyms in parentheses exactly as-is, e.g. "(RCA)", "(SNAP)", "(TANF)".
- Use warm, plain language for low-literacy readers. Never add, drop, or reorder items.
Output ONLY the translated JSON object, no prose, no code fences.`,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const parsed = extractJson(text) as
      | { summary?: string; benefits?: Array<Record<string, unknown>> }
      | null;
    if (!parsed || !Array.isArray(parsed.benefits)) return result;

    const byId = new Map(parsed.benefits.map((b) => [String(b.id), b]));
    const benefits = result.benefits.map((b) => {
      const t = byId.get(b.id);
      if (!t) return b;
      const str = (v: unknown, fb: string | undefined) =>
        typeof v === "string" && v.trim() ? v : fb;
      const reqd =
        Array.isArray(t.requiredDocuments) &&
        t.requiredDocuments.length === (b.requiredDocuments?.length ?? 0)
          ? (t.requiredDocuments as string[])
          : b.requiredDocuments;
      const steps =
        Array.isArray(t.nextSteps) && t.nextSteps.length === (b.nextSteps?.length ?? 0)
          ? (t.nextSteps as string[])
          : b.nextSteps;
      return {
        ...b,
        name: str(t.name, b.name),
        whyPlainLanguage: str(t.why, b.whyPlainLanguage),
        deadline: { ...(b.deadline ?? {}), label: str(t.deadlineLabel, b.deadline?.label) },
        requiredDocuments: reqd,
        nextSteps: steps,
      };
    });

    return {
      ...result,
      language: targetLang,
      summary: str0(parsed.summary, result.summary),
      benefits,
    };
  } catch {
    return result;
  }
}

function str0(v: unknown, fb: string | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v : fb;
}
