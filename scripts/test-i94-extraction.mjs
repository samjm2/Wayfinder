// Real end-to-end test of the onboarding document reader against an I-94.
//
// It exercises the SAME prompt + model + parsing the app uses (no mocks): it
// builds a faithful CBP I-94 image with known ground-truth values, sends it to
// Claude vision, runs the shared parseExtraction(), and asserts every field
// maps to the correct slot — in particular that the BIRTH DATE is never read off
// the ENTRY date.
//
// Run (loads the key from .env.local):
//   node --env-file=.env.local --experimental-strip-types \
//     --import ./scripts/alias-register.mjs scripts/test-i94-extraction.mjs
//
// Test your OWN document instead of the synthetic one:
//   node ... scripts/test-i94-extraction.mjs /path/to/real-i94.png
//   (pass expected values as JSON in $EXPECT to assert against them)

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACT_PROMPT, parseExtraction } from "@/lib/onboarding/i94Extract.ts";
import { HAIKU } from "@/lib/claude.ts";

// ── Fixtures (selectable via FIXTURE=<name>) ─────────────────────────────────
// "classic" = modern i94.cbp.dhs.gov printout (dates like "2024 September 15").
// "lydia"   = the legacy "Admission (I-94) Number Retrieval" screenshot with
//             MM/DD/YYYY dates, a passport number (must NOT be extracted), and a
//             B1 visitor class (not an eligible humanitarian status → dropped).

const CLASSIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="660" viewBox="0 0 1000 660">
  <rect width="1000" height="660" fill="#ffffff"/>
  <rect x="0" y="0" width="1000" height="70" fill="#1a3a5c"/>
  <text x="30" y="44" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#ffffff">U.S. Customs and Border Protection</text>
  <text x="30" y="115" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="#111111">Arrival/Departure Record - I-94</text>
  <line x1="30" y1="135" x2="970" y2="135" stroke="#999999" stroke-width="2"/>
  <text x="30" y="185" font-family="Arial, sans-serif" font-size="22" fill="#333333">Admission (I-94) Record Number:</text>
  <text x="430" y="185" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">12345678901</text>
  <text x="30" y="235" font-family="Arial, sans-serif" font-size="22" fill="#333333">Most Recent Date of Entry:</text>
  <text x="430" y="235" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">2024 September 15</text>
  <text x="30" y="285" font-family="Arial, sans-serif" font-size="22" fill="#333333">Class of Admission:</text>
  <text x="430" y="285" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">RE</text>
  <text x="30" y="335" font-family="Arial, sans-serif" font-size="22" fill="#333333">Admit Until Date:</text>
  <text x="430" y="335" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">D/S</text>
  <line x1="30" y1="365" x2="970" y2="365" stroke="#cccccc" stroke-width="1"/>
  <text x="30" y="410" font-family="Arial, sans-serif" font-size="22" fill="#333333">Last/Surname:</text>
  <text x="430" y="410" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">DOE</text>
  <text x="30" y="460" font-family="Arial, sans-serif" font-size="22" fill="#333333">First (Given) Name:</text>
  <text x="430" y="460" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">JANE</text>
  <text x="30" y="510" font-family="Arial, sans-serif" font-size="22" fill="#333333">Birth Date:</text>
  <text x="430" y="510" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">1990 April 12</text>
  <text x="30" y="560" font-family="Arial, sans-serif" font-size="22" fill="#333333">Country of Citizenship:</text>
  <text x="430" y="560" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#111111">AFGHANISTAN</text>
</svg>`;

const LYDIA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="560" viewBox="0 0 760 560">
  <rect width="760" height="560" fill="#ffffff"/>
  <rect x="0" y="0" width="760" height="58" fill="#23509a"/>
  <text x="58" y="30" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff">U.S. Customs and Border Protection</text>
  <text x="58" y="50" font-family="Arial, sans-serif" font-size="13" fill="#cdd9ee">Securing America's Borders</text>
  <rect x="0" y="58" width="760" height="34" fill="#e8edf5"/>
  <text x="30" y="80" font-family="Arial, sans-serif" font-size="14" fill="#23509a">Get I-94 Number</text>
  <text x="220" y="80" font-family="Arial, sans-serif" font-size="14" fill="#23509a">I-94 FAQ</text>
  <text x="30" y="130" font-family="Arial, sans-serif" font-size="19" font-weight="bold" fill="#1a3a6b">Admission (I-94) Number Retrieval</text>
  <text x="30" y="185" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#1a3a6b">Admission (I-94) Record Number:</text>
  <text x="420" y="185" font-family="Arial, sans-serif" font-size="16" fill="#111111">69000888062</text>
  <text x="30" y="225" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#1a3a6b">Admit Until Date (MM/DD/YYYY):</text>
  <text x="420" y="225" font-family="Arial, sans-serif" font-size="16" fill="#111111">10/10/2012</text>
  <text x="30" y="270" font-family="Arial, sans-serif" font-size="15" fill="#444444">Details provided on Admission(I-94) form:</text>
  <text x="30" y="315" font-family="Arial, sans-serif" font-size="15" fill="#333333">Family Name:</text>
  <text x="420" y="315" font-family="Arial, sans-serif" font-size="15" fill="#111111">LI</text>
  <text x="30" y="350" font-family="Arial, sans-serif" font-size="15" fill="#333333">First (Given) Name:</text>
  <text x="420" y="350" font-family="Arial, sans-serif" font-size="15" fill="#111111">LYDIA</text>
  <text x="30" y="385" font-family="Arial, sans-serif" font-size="15" fill="#333333">Birth Date (MM/DD/YYYY):</text>
  <text x="420" y="385" font-family="Arial, sans-serif" font-size="15" fill="#111111">01/01/1990</text>
  <text x="30" y="420" font-family="Arial, sans-serif" font-size="15" fill="#333333">Passport Number:</text>
  <text x="420" y="420" font-family="Arial, sans-serif" font-size="15" fill="#111111">P123123213</text>
  <text x="30" y="455" font-family="Arial, sans-serif" font-size="15" fill="#333333">Passport Country of Issuance:</text>
  <text x="420" y="455" font-family="Arial, sans-serif" font-size="15" fill="#111111">Mexico</text>
  <text x="30" y="490" font-family="Arial, sans-serif" font-size="15" fill="#333333">Date of Entry (MM/DD/YYYY):</text>
  <text x="420" y="490" font-family="Arial, sans-serif" font-size="15" fill="#111111">04/11/2012</text>
  <text x="30" y="525" font-family="Arial, sans-serif" font-size="15" fill="#333333">Class of Admission:</text>
  <text x="420" y="525" font-family="Arial, sans-serif" font-size="15" fill="#111111">B1</text>
</svg>`;

const FIXTURES = {
  classic: {
    svg: CLASSIC_SVG,
    truth: {
      full_name: "JANE DOE",
      date_of_birth: "1990-04-12",
      arrival_date: "2024-09-15",
      immigration_status: "refugee_207",
      country_of_origin: "Afghanistan",
    },
  },
  lydia: {
    svg: LYDIA_SVG,
    truth: {
      full_name: "LYDIA LI",
      date_of_birth: "1990-01-01", // 01/01/1990
      arrival_date: "2012-04-11", // Date of Entry 04/11/2012 (MM/DD)
      // Class B1 is not an eligible humanitarian status → other_none → dropped.
      // Passport number P123123213 must NEVER appear anywhere in the output.
    },
  },
};

const FIXTURE = process.env.FIXTURE && FIXTURES[process.env.FIXTURE] ? process.env.FIXTURE : "classic";
const GROUND_TRUTH = FIXTURES[FIXTURE].truth;
function buildI94Svg() {
  return FIXTURES[FIXTURE].svg;
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
};

async function buildContentBlock() {
  const arg = process.argv[2];
  if (arg) {
    const ext = extname(arg).toLowerCase();
    const media = MIME[ext];
    if (!media) throw new Error(`Unsupported file type: ${ext}`);
    const data = readFileSync(arg).toString("base64");
    console.log(`Using REAL document: ${arg} (${media})`);
    if (media === "application/pdf") {
      return { type: "document", source: { type: "base64", media_type: media, data } };
    }
    return { type: "image", source: { type: "base64", media_type: media, data } };
  }
  console.log(`Using SYNTHETIC I-94 [${FIXTURE}]. Ground truth:`, GROUND_TRUTH);
  let png = await sharp(Buffer.from(buildI94Svg())).png().toBuffer();
  // Optionally DEGRADE to mimic a small low-res screenshot (e.g. WIDTH=300).
  if (process.env.WIDTH) {
    png = await sharp(png).resize({ width: Number(process.env.WIDTH) }).png().toBuffer();
    console.log(`Degraded to width ${process.env.WIDTH}px`);
  }
  // Optionally apply the SAME normalization the route uses before OCR (PREP=1).
  if (process.env.PREP) {
    const { normalizeImageForOcr } = await import("@/lib/onboarding/ocrImage.ts");
    const norm = await normalizeImageForOcr(png);
    png = norm.data;
    console.log(`Normalized for OCR -> ${png.length} bytes`);
  }
  return { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
}

function expected() {
  if (process.env.EXPECT) {
    try { return { ...GROUND_TRUTH, ...JSON.parse(process.env.EXPECT) }; } catch { /* ignore */ }
  }
  return process.argv[2] ? null : GROUND_TRUTH; // no asserts for an unknown real doc unless EXPECT given
}

function val(f) { return f ? `${f.value} (${f.confidence})` : "—"; }

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Run with --env-file=.env.local");
    process.exit(2);
  }

  const block = await buildContentBlock();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const res = await client.messages.create({
    model: HAIKU,
    max_tokens: 1000,
    messages: [{ role: "user", content: [block, { type: "text", text: EXTRACT_PROMPT }] }],
  });
  const rawText = res.content[0]?.type === "text" ? res.content[0].text : "";

  console.log("\n── Raw model reply ─────────────────────────────────────────");
  console.log(rawText);

  const out = parseExtraction(rawText);
  const f = out.fields;
  console.log("\n── Parsed + mapped fields ──────────────────────────────────");
  console.log("documents_detected:", out.documents_detected.join(", ") || "—");
  console.log("immigration_status:", val(f.immigration_status));
  console.log("full_name:        ", val(f.full_name));
  console.log("date_of_birth:    ", val(f.date_of_birth));
  console.log("arrival_date:     ", val(f.arrival_date));
  console.log("eligibility_date: ", val(f.eligibility_date));
  console.log("country_of_origin:", val(f.country_of_origin));
  console.log("age:              ", val(f.age));
  console.log("tokens:", res.usage.input_tokens, "in /", res.usage.output_tokens, "out");

  const exp = expected();
  if (!exp) { console.log("\n(no expected values — skipped assertions)"); return; }

  const checks = [];
  const got = {
    full_name: f.full_name?.value?.toUpperCase(),
    date_of_birth: f.date_of_birth?.value,
    arrival_date: f.arrival_date?.value,
    immigration_status: f.immigration_status?.value,
    country_of_origin: f.country_of_origin?.value,
  };
  for (const [k, want] of Object.entries(exp)) {
    const g = k === "full_name" ? got.full_name : got[k];
    const ok = k === "country_of_origin"
      ? (g || "").toLowerCase().includes(String(want).toLowerCase())
      : k === "full_name"
        ? (g || "").includes(String(want).toUpperCase())
        : g === want;
    checks.push({ field: k, want, got: g ?? "—", ok });
  }
  // The headline guard: DOB must never equal the entry date.
  const dobIsEntry = f.date_of_birth && f.arrival_date && f.date_of_birth.value === f.arrival_date.value;
  checks.push({ field: "DOB ≠ entry date", want: "true", got: String(!dobIsEntry), ok: !dobIsEntry });

  // Sensitive-leak guard: a passport / doc number must never appear anywhere.
  const haystack = rawText + " " + JSON.stringify(out.fields);
  for (const bad of ["P123123213", "123123213"]) {
    if (rawText.includes(bad) || FIXTURE === "lydia") {
      const leaked = haystack.includes(bad);
      checks.push({ field: `no passport leak (${bad})`, want: "absent", got: leaked ? "LEAKED" : "absent", ok: !leaked });
    }
  }

  console.log("\n── Assertions ──────────────────────────────────────────────");
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.field}: expected "${c.want}", got "${c.got}"`);
    if (!c.ok) failed++;
  }
  console.log(failed === 0 ? "\nALL PASSED ✅" : `\n${failed} CHECK(S) FAILED ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
