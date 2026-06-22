import enStrings from "@/locales/en.json";
import { getClaudeClient, SONNET } from "./claude";
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

// Deep-merge a (possibly incomplete or stale) translation OVER the English base
// so every key the app reads always exists. Any key the translation is missing
// falls back to English — this prevents `t.someKey` from being undefined (which
// crashes the client with a "reload the page" error) and degrades gracefully to
// English for untranslated bits instead of blanks.
function deepMergeOverEnglish<T>(base: T, override: unknown): T {
  if (Array.isArray(base)) {
    // Only adopt the translated array if it has the same length (same shape);
    // otherwise keep the English array.
    return (Array.isArray(override) && override.length === base.length ? override : base) as T;
  }
  if (base && typeof base === "object") {
    const ov = (override && typeof override === "object" ? override : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(base as Record<string, unknown>)) {
      out[k] = deepMergeOverEnglish((base as Record<string, unknown>)[k], ov[k]);
    }
    return out as T;
  }
  // Primitive (string): use the translation if it's a non-empty string, else English.
  return (typeof override === "string" && override.length > 0 ? override : base) as T;
}

function mergeStrings(translation: unknown): UIStrings {
  return deepMergeOverEnglish(enStrings, translation);
}

// Completeness check: walk every key in `base` and require it to be present in
// `obj`. Returns false if any key in `base` is missing/undefined in `obj`. For
// nested objects we recurse; for arrays we require EQUAL length (a shorter
// translated array means the file was generated against an older, smaller
// en.json and is therefore incomplete); for primitives we only require the key
// to EXIST in `obj` (key presence, NOT value equality — a complete-but-different
// translation must pass). Cheap and side-effect-free.
function hasAllKeys(base: unknown, obj: unknown): boolean {
  if (Array.isArray(base)) {
    if (!Array.isArray(obj) || obj.length !== base.length) return false;
    for (let i = 0; i < base.length; i++) {
      if (!hasAllKeys(base[i], obj[i])) return false;
    }
    return true;
  }
  if (base && typeof base === "object") {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(base as Record<string, unknown>)) {
      if (!(k in o) || o[k] === undefined) return false;
      if (!hasAllKeys((base as Record<string, unknown>)[k], o[k])) return false;
    }
    return true;
  }
  // Primitive: only require the key to exist (the caller already checked `k in o`
  // and that the value isn't undefined). Don't compare values — a real
  // translation differs from English.
  return true;
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
    // Serve any structurally-valid static file, deep-merged over English. A
    // single missing key (one the translator happened to drop, or a key added
    // after this file was generated) just falls back to English — far better
    // than rejecting the whole file and forcing a slow live re-translation that
    // stalls the language switch. Pre-generated files (scripts/pretranslate.mjs,
    // run against the CURRENT en.json) are complete; this keeps a near-complete
    // file instant instead of leaving the page stuck on "Translating…".
    if (isValidStrings(parsed)) return mergeStrings(parsed);
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
    cached.translations.landing.hero.headline !== enStrings.landing.hero.headline &&
    hasAllKeys(enStrings, cached.translations)
  ) {
    return mergeStrings(cached.translations);
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

  return mergeStrings(translated);
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
    model: SONNET,
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
