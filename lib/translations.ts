import enStrings from "@/locales/en.json";
import { getClaudeClient, HAIKU } from "./claude";
import { SUPPORTED_LANGUAGES } from "./languages";

export type UIStrings = typeof enStrings;
export { SUPPORTED_LANGUAGES };

export function getEnglishStrings(): UIStrings {
  return enStrings;
}

// Structural sanity check: a real translation keeps the current string shape.
// Also rejects rows cached under an older en.json shape so they regenerate
// instead of rendering blanks.
function isValidStrings(obj: unknown): obj is UIStrings {
  const o = obj as UIStrings | undefined;
  return (
    !!o &&
    typeof o.landing?.hero?.headline === "string" &&
    Array.isArray(o.landing?.how?.steps) &&
    typeof o.nav?.signIn === "string"
  );
}

// Fetch translations from Supabase cache or generate via Claude
export async function getTranslations(languageCode: string): Promise<UIStrings> {
  if (languageCode === "en") return enStrings;

  // 1) Pre-generated static file (instant — no network, no LLM). These are
  // produced offline by scripts/pretranslate.mjs against the current en.json and
  // are the fast path for language switching. Dynamic fs import keeps this
  // module safe to import from server code without bundling fs elsewhere.
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const raw = await readFile(
      join(process.cwd(), "locales", "generated", `${languageCode}.json`),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    if (isValidStrings(parsed)) return parsed;
  } catch {
    /* no static file yet — fall through to cache / live translation */
  }

  // Dynamic import to avoid bundling supabase in client chunks
  const { createServiceClient } = await import("./supabase/server");
  const supabase = await createServiceClient();

  // Try cache first — but ignore rows that don't match the current shape.
  const { data: cached } = await supabase
    .from("ui_translations")
    .select("translations")
    .eq("language_code", languageCode)
    .single();

  // A row whose hero headline still matches English is a stale English
  // fallback from before validation existed — ignore it and regenerate, which
  // upserts a real translation over the bad row (we can't delete shared rows).
  if (
    cached?.translations &&
    isValidStrings(cached.translations) &&
    cached.translations.landing.hero.headline !== enStrings.landing.hero.headline
  ) {
    return cached.translations;
  }

  // Generate with Claude. If this throws (truncated / malformed output), let it
  // bubble up — we do NOT cache or persist an English fallback, so a later
  // retry can still succeed.
  const translated = await translateStringsWithClaude(languageCode);

  // Cache for future users (only reached on a valid translation). The table's
  // PK is `id`, so upsert must conflict on the unique `language_code` to UPDATE
  // an existing row rather than insert a duplicate (which the unique constraint
  // rejects). Without this, a regenerated translation never overwrites a stale
  // cached row.
  const { error: cacheError } = await supabase
    .from("ui_translations")
    .upsert(
      {
        language_code: languageCode,
        language_name: SUPPORTED_LANGUAGES.find((l) => l.code === languageCode)?.nativeName ?? languageCode,
        translations: translated,
      },
      { onConflict: "language_code" }
    );
  if (cacheError) console.error("[translations] cache write failed:", cacheError.message);

  return translated;
}

function extractJson(text: string): string {
  let raw = text.trim();
  // Strip ```json … ``` fences if the model added them.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  // Trim anything before the first { / after the last }.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) raw = raw.slice(first, last + 1);
  return raw;
}

async function translateStringsWithClaude(languageCode: string): Promise<UIStrings> {
  const client = getClaudeClient();
  const langName = SUPPORTED_LANGUAGES.find((l) => l.code === languageCode)?.name ?? languageCode;

  // Stream so we can request generous headroom (non-Latin scripts tokenize
  // larger) without risking an SDK HTTP timeout. Truncation at a low
  // max_tokens was the cause of silent English fallbacks.
  const stream = client.messages.stream({
    model: HAIKU,
    max_tokens: 32000,
    messages: [
      {
        role: "user",
        content: `Translate the following JSON UI strings into ${langName} (language code: ${languageCode}).

Rules:
- Preserve every JSON key exactly as-is. Only translate the string values.
- Preserve placeholders like {current}, {total}, {days} exactly as written.
- Keep the JSON structure identical (same nesting, same arrays, same number of items).
- Use natural, plain-language translation appropriate for low-literacy readers.
- Output ONLY the translated JSON object: no explanation, no markdown fences.

JSON to translate:
${JSON.stringify(enStrings, null, 2)}`,
      },
    ],
  });

  const message = await stream.finalMessage();
  const text = message.content[0]?.type === "text" ? message.content[0].text : "";
  const parsed = JSON.parse(extractJson(text)) as UIStrings;

  if (!isValidStrings(parsed)) {
    throw new Error(`Claude returned a malformed translation for ${languageCode}`);
  }
  return parsed;
}
