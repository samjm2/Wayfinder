// Pre-generate UI translations to locales/generated/<code>.json so language
// switching is INSTANT at runtime (a disk read) instead of a live LLM call.
//
// Usage (from repo root):
//   node scripts/pretranslate.mjs            # generate all missing languages
//   node scripts/pretranslate.mjs es ar fa   # only these codes
//   node scripts/pretranslate.mjs --force    # regenerate everything (after en.json changes)
//
// Reads ANTHROPIC_API_KEY from .env.local. Writes each file as it completes,
// so partial runs still help and re-runs only fill what's missing.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "locales", "generated");
const MODEL = "claude-haiku-4-5";
const CONCURRENCY = 5;

function loadEnv() {
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const i = line.indexOf("=");
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

function parseLanguages(src) {
  // Extract { code: "xx", name: "Yy" } pairs from lib/languages.ts.
  const out = [];
  const re = /code:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) out.push({ code: m[1], name: m[2] });
  return out;
}

async function translate(client, enJson, lang) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    messages: [{
      role: "user",
      content: `Translate the following JSON UI strings into ${lang.name} (language code: ${lang.code}).

Rules:
- Preserve every JSON key exactly as-is. Only translate the string values.
- Preserve placeholders like {current}, {total}, {days}, {age}, {message} exactly as written.
- Keep the JSON structure identical (same nesting, same arrays, same number of items).
- Use natural, plain-language translation appropriate for low-literacy readers.
- Output ONLY the translated JSON object: no explanation, no markdown fences.

JSON to translate:
${enJson}`,
    }],
  });
  const msg = await stream.finalMessage();
  let text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  text = text.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) text = text.slice(first, last + 1);
  const parsed = JSON.parse(text); // throws on malformed -> caller reports
  // sanity check
  if (!parsed?.nav?.signIn || !parsed?.landing?.hero?.headline) {
    throw new Error("missing expected keys");
  }
  return parsed;
}

async function main() {
  loadEnv();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not found (checked process.env and .env.local).");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyCodes = args.filter((a) => !a.startsWith("--"));

  const enJson = await readFile(join(ROOT, "locales", "en.json"), "utf8");
  const langsSrc = await readFile(join(ROOT, "lib", "languages.ts"), "utf8");
  let langs = parseLanguages(langsSrc).filter((l) => l.code !== "en");
  if (onlyCodes.length) langs = langs.filter((l) => onlyCodes.includes(l.code));

  await mkdir(OUT_DIR, { recursive: true });
  const existing = new Set((existsSync(OUT_DIR) ? await readdir(OUT_DIR) : []).map((f) => f.replace(/\.json$/, "")));

  const todo = langs.filter((l) => force || !existing.has(l.code));
  console.log(`Languages: ${langs.length} total, ${todo.length} to generate${force ? " (force)" : ""}.`);
  if (!todo.length) { console.log("Nothing to do."); return; }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let done = 0, failed = 0;
  const queue = [...todo];

  async function worker() {
    while (queue.length) {
      const lang = queue.shift();
      if (!lang) break;
      const started = Date.now();
      try {
        const parsed = await translate(client, enJson, lang);
        await writeFile(join(OUT_DIR, `${lang.code}.json`), JSON.stringify(parsed, null, 2) + "\n", "utf8");
        done++;
        console.log(`  ✓ ${lang.code} (${lang.name}) ${(Date.now() - started) / 1000}s  [${done}/${todo.length}]`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${lang.code} (${lang.name}): ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));
  console.log(`Done. ${done} generated, ${failed} failed. Output: locales/generated/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
