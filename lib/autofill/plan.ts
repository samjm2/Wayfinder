// Pure planning core for the AI portal autofill agent.
//
// The Chrome extension snapshots the current page (fields, labels, buttons,
// errors, step markers) and POSTs it to /api/autofill/plan. The model returns a
// list of next actions; the extension executes the safe ones. This module owns
// the prompt and the DETERMINISTIC validation that turns a model reply into a
// safe, executable plan — no network, no DOM, so it can be unit-tested.
//
// Safety is enforced in code, not just asked for in the prompt:
//   • Sensitive fields (SSN, A-number, bank, password, signature…) are NEVER
//     filled — any fill targeting one is rewritten to a user handoff.
//   • The final "submit application" button is NEVER clicked automatically — a
//     click on a final-submit button becomes a "review" pause.
//   • We never invent values: a fill must carry a value; otherwise it's dropped
//     and the field is surfaced as a question.

import { isSensitiveName, type ProfileValues } from "@/lib/formFill";

// ── Snapshot shape (produced by the extension content script) ────────────────
export interface SnapshotField {
  ref: string; // stable handle the executor can target
  label: string; // best-effort label/aria/placeholder text
  type: string; // text | email | tel | date | select | checkbox | radio | textarea | password | number
  name?: string;
  placeholder?: string;
  required?: boolean;
  value?: string; // current value (so we never overwrite the user)
  options?: string[]; // for select/radio
}
export interface SnapshotButton {
  ref: string;
  text: string;
  kind: "submit" | "button" | "link";
}
export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  fields: SnapshotField[];
  buttons: SnapshotButton[];
  errors: string[];
  step?: string;
}

// ── Plan actions returned to the extension ───────────────────────────────────
export type PlanAction =
  | { action: "fill"; ref: string; value: string; label: string; reason: string }
  | { action: "select"; ref: string; value: string; label: string; reason: string }
  | { action: "check"; ref: string; value: boolean; label: string; reason: string }
  | { action: "click"; ref: string; label: string; reason: string }
  | { action: "ask_user"; field: string; question: string; reason: string }
  | { action: "handoff_sensitive"; ref: string; label: string; reason: string }
  | { action: "review"; reason: string }
  | { action: "done"; reason: string };

export interface Plan {
  pageType: string;
  summary: string;
  actions: PlanAction[];
}

// A click on any of these is treated as a FINAL submission and downgraded to a
// review pause — the user must explicitly confirm before an application is filed.
const FINAL_SUBMIT_RE =
  /\b(submit|file|finish|complete|confirm|sign|certify|agree|pay|place order|send application)\b/i;

// A "continue to next step" button is safe to click automatically.
const NEXT_RE = /\b(next|continue|save (and|&) continue|proceed|go on|forward|start)\b/i;

export function isFinalSubmit(text: string): boolean {
  return FINAL_SUBMIT_RE.test(text) && !NEXT_RE.test(text);
}

// Redact obvious sensitive numbers from any text we send to the model (snapshot
// values, error strings) — defense-in-depth so a value the user already typed
// never reaches the prompt.
const SCRUBBERS: Array<[RegExp, string]> = [
  [/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, "[REDACTED]"], // SSN
  [/\bA[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{2,3}\b/gi, "[REDACTED]"], // A-number
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED]"], // card-like
  [/\b\d{9,}\b/g, "[REDACTED]"], // long digit runs
];
export function scrub(text: string): string {
  let out = text ?? "";
  for (const [re, repl] of SCRUBBERS) out = out.replace(re, repl);
  return out;
}

function scrubField(f: SnapshotField): SnapshotField {
  return {
    ...f,
    label: scrub(f.label).slice(0, 200),
    placeholder: f.placeholder ? scrub(f.placeholder).slice(0, 120) : undefined,
    // Never echo the current value of a sensitive field; scrub others.
    value: f.value
      ? isSensitiveName(`${f.label} ${f.name ?? ""}`)
        ? "[hidden]"
        : scrub(f.value).slice(0, 120)
      : undefined,
    options: f.options?.slice(0, 30).map((o) => scrub(o).slice(0, 80)),
  };
}

export function scrubSnapshot(s: PageSnapshot): PageSnapshot {
  return {
    url: (s.url ?? "").slice(0, 300),
    title: scrub(s.title ?? "").slice(0, 200),
    headings: (s.headings ?? []).slice(0, 12).map((h) => scrub(h).slice(0, 160)),
    fields: (s.fields ?? []).slice(0, 60).map(scrubField),
    buttons: (s.buttons ?? []).slice(0, 20).map((b) => ({ ...b, text: scrub(b.text).slice(0, 80) })),
    errors: (s.errors ?? []).slice(0, 20).map((e) => scrub(e).slice(0, 200)),
    step: s.step ? scrub(s.step).slice(0, 80) : undefined,
  };
}

export const PLANNER_SYSTEM = `You are Wayfinder's portal navigator. You help a refugee/immigrant complete an external U.S. government benefits or immigration application by deciding the next safe actions on the CURRENT page only.

You are given:
- A SNAPSHOT of the current page: its headings, form fields (each with a "ref"), buttons, any visible validation errors, and a step indicator.
- The user's PROFILE: the non-sensitive facts we already know about them.

Reason through these for THIS page, then output actions:
1. What page/step is this? 2. What is it asking for? 3. Which fields can I fill from the profile? 4. Which fields need info we don't have? 5. Which fields are sensitive and must be left to the user? 6. What is the next safe action? 7. Did the page report errors to fix? 8. Is there a "next/continue" button to advance, or is this a review/submit page?

HARD RULES — follow exactly:
- NEVER fill a sensitive field yourself (Social Security Number, A-Number/USCIS number, passport number, bank account/routing, credit card, password, security question/answer, signature, legal attestation/certification checkbox). For each sensitive field that needs a value, emit a "handoff_sensitive" action so the user fills it themselves.
- For YES/NO questions, radio buttons, and multiple-choice options, pick the correct option and emit a "check" action on THAT option's ref (value true) — or a "click" if the option is a button/link. NEVER use "fill" for a radio button or checkbox.
- NEVER invent or guess a value. Only "fill"/"select" a field when the PROFILE actually contains that fact. If a non-sensitive field is required but unknown, emit one "ask_user" action with a short, plain-language question and why it's needed.
- NEVER click a button that SUBMITS or FILES the application, signs, certifies, agrees, or pays. If the page is a review/confirmation/submit page, emit a single "review" action instead and stop.
- GUEST APPLICATIONS: Many portals let people apply WITHOUT an account. If the page offers any way to proceed without signing in — a button or link like "Apply as Guest", "Continue as guest", "Continue without signing in", "Start a new application", "Apply for benefits" — PREFER it: click that button to begin the application. In this case do NOT classify the page as "login" even if a sign-in box is also present elsewhere on the page. Only use pageType "login" when signing in is the ONLY way forward and there is no guest/apply option at all.
- It is safe to click a "Next/Continue/Save and continue" button AFTER you have filled everything you can on this page and there are no unresolved required fields or errors.
- Prefer filling all known fields first, then ask_user for any missing required ones, then (only if nothing is blocking) a click to continue.
- If everything on the page is already filled and the only thing left is to advance, emit the click. If the application is finished, emit "done".

Output ONLY a JSON object, no prose, in EXACTLY this shape:
{
  "pageType": "application_step | login | review | confirmation | error | unknown",
  "summary": "one short sentence describing this page for the user",
  "actions": [
    { "action": "fill", "ref": "<field ref>", "value": "<value from profile>", "label": "<field label>", "reason": "<why>" },
    { "action": "select", "ref": "<field ref>", "value": "<option>", "label": "<label>", "reason": "<why>" },
    { "action": "check", "ref": "<field ref>", "value": true, "label": "<label>", "reason": "<why>" },
    { "action": "ask_user", "field": "<short key>", "question": "<plain question>", "reason": "<why needed>" },
    { "action": "handoff_sensitive", "ref": "<field ref>", "label": "<label>", "reason": "<why sensitive>" },
    { "action": "click", "ref": "<button ref>", "label": "<button text>", "reason": "advance to next step" },
    { "action": "review", "reason": "this page submits the application; waiting for user confirmation" },
    { "action": "done", "reason": "application complete" }
  ]
}`;

export function buildPlannerUserMessage(
  snapshot: PageSnapshot,
  profile: ProfileValues,
  askedKeys: string[] = [],
  answers: Record<string, string> = {},
): string {
  const safe = scrubSnapshot(snapshot);
  const profileLines = Object.entries(profile)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const answerLines = Object.entries(answers)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${scrub(String(v)).slice(0, 120)}`)
    .join("\n");
  return [
    "PROFILE (non-sensitive facts we know about the user):",
    profileLines || "(nothing known yet)",
    answerLines
      ? `\nANSWERS the user just gave to earlier questions (treat as known facts you may use to fill matching fields):\n${answerLines}`
      : "",
    askedKeys.length
      ? `\nWe have ALREADY asked the user about these (don't ask again): ${askedKeys.join(", ")}`
      : "",
    "",
    "PAGE SNAPSHOT (JSON):",
    JSON.stringify(safe),
    "",
    "Return the JSON plan for the next safe actions on this page.",
  ].join("\n");
}

// ── Deterministic validation / safety enforcement ────────────────────────────
function firstJsonObject(raw: string): Record<string, unknown> {
  try {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(raw.slice(a, b + 1));
  } catch {
    /* ignore */
  }
  return {};
}

const PAGE_TYPES = new Set(["application_step", "login", "review", "confirmation", "error", "unknown"]);

export function validatePlan(rawText: string, snapshot: PageSnapshot): Plan {
  const parsed = firstJsonObject(rawText);
  const fieldByRef = new Map(snapshot.fields.map((f) => [f.ref, f]));
  const buttonByRef = new Map(snapshot.buttons.map((b) => [b.ref, b]));

  const pageType = typeof parsed.pageType === "string" && PAGE_TYPES.has(parsed.pageType)
    ? (parsed.pageType as string)
    : "unknown";
  const summary = typeof parsed.summary === "string" ? scrub(parsed.summary).slice(0, 200) : "";

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const out: PlanAction[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  for (const a of rawActions as Array<Record<string, unknown>>) {
    const kind = str(a.action);
    const reason = scrub(str(a.reason)).slice(0, 200);

    if (kind === "fill" || kind === "select") {
      const ref = str(a.ref);
      const field = fieldByRef.get(ref);
      if (!field) continue; // ref must exist
      const value = scrub(str(a.value));
      if (!value) continue; // never fill an empty/invented value
      const label = scrub(str(a.label) || field.label).slice(0, 120);
      // Sensitive field → force a user handoff regardless of what the model said.
      if (isSensitiveName(`${field.label} ${field.name ?? ""} ${field.type}`)) {
        out.push({ action: "handoff_sensitive", ref, label, reason: reason || "sensitive field — you should enter this yourself" });
        continue;
      }
      out.push({ action: kind, ref, value: value.slice(0, 200), label, reason });
    } else if (kind === "check") {
      const ref = str(a.ref);
      const field = fieldByRef.get(ref);
      if (!field) continue;
      const label = scrub(str(a.label) || field.label).slice(0, 120);
      // Never auto-check an attestation/agreement/certify box — that's a legal act.
      if (isSensitiveName(`${field.label} ${field.name ?? ""}`) || /\b(agree|certif|attest|consent|declare|under penalty)\b/i.test(field.label)) {
        out.push({ action: "handoff_sensitive", ref, label, reason: reason || "this confirmation should be made by you" });
        continue;
      }
      out.push({ action: "check", ref, value: a.value === true || a.value === "true", label, reason });
    } else if (kind === "click") {
      const ref = str(a.ref);
      const btn = buttonByRef.get(ref);
      if (!btn) continue;
      // A final-submit click is downgraded to a review pause.
      if (isFinalSubmit(btn.text)) {
        out.push({ action: "review", reason: reason || `"${btn.text}" submits the application — waiting for your confirmation` });
        continue;
      }
      out.push({ action: "click", ref, label: scrub(btn.text).slice(0, 80), reason });
    } else if (kind === "handoff_sensitive") {
      const ref = str(a.ref);
      const field = fieldByRef.get(ref);
      if (!field) continue;
      out.push({ action: "handoff_sensitive", ref, label: scrub(str(a.label) || field.label).slice(0, 120), reason });
    } else if (kind === "ask_user") {
      const field = scrub(str(a.field)).slice(0, 60);
      const question = scrub(str(a.question)).slice(0, 240);
      if (!question) continue;
      out.push({ action: "ask_user", field: field || "info", question, reason });
    } else if (kind === "review") {
      out.push({ action: "review", reason });
    } else if (kind === "done") {
      out.push({ action: "done", reason });
    }
    // unknown action kinds are dropped
  }

  // Never auto-advance past an unresolved page. If a required field is still
  // unfilled, the page is showing validation errors, or we need something from
  // the user (ask_user / sensitive handoff), drop any "click to continue" — the
  // user (or a later round, once fields are filled) resolves it first.
  const addressed = new Set(
    out.filter((a) => "ref" in a).map((a) => (a as { ref: string }).ref),
  );
  const requiredUnmet = snapshot.fields.some(
    (f) => f.required && !f.value && !addressed.has(f.ref),
  );
  const needsUser = out.some((a) => a.action === "ask_user" || a.action === "handoff_sensitive");
  const blockAdvance = requiredUnmet || (snapshot.errors?.length ?? 0) > 0 || needsUser;
  let actions = blockAdvance ? out.filter((a) => a.action !== "click") : out;

  // If the model produced nothing actionable but the page clearly submits, pause
  // on review rather than returning an empty plan.
  if (actions.length === 0) {
    const hasFinal = snapshot.buttons.some((b) => isFinalSubmit(b.text));
    actions = [hasFinal
      ? { action: "review", reason: "this looks like a submit/review page — waiting for your confirmation" }
      : { action: "done", reason: "no further automatic actions available on this page" }];
  }

  return { pageType, summary, actions };
}
