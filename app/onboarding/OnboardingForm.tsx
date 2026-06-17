"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { createClient } from "@/lib/supabase/client";
import LanguagePicker from "@/components/LanguagePicker";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import type { ImmigrationStatus } from "@/lib/types";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

// Order of the immigration status options. Labels/notes come from translations.
const IMMIGRATION_VALUES: ImmigrationStatus[] = [
  "refugee_207",
  "asylee_208",
  "siv",
  "afghan_parolee",
  "ukrainian_parolee",
  "cuban_haitian_entrant",
  "trafficking_victim",
  "amerasian",
  "lpr_from_humanitarian",
  "lpr_other",
  "us_citizen",
  "other_none",
];

// Status sets mirror app/api/eligibility/route.ts
// ORR-eligible -> eligibility_date matters (RCA/RMA/MG)
const ORR_STATUSES: ImmigrationStatus[] = [
  "refugee_207", "asylee_208", "siv", "afghan_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
];
// Only these have a 'status granted' date for the SSI 7-yr clock;
// siv/parolees use arrival instead.
const STATUS_GRANT_STATUSES: ImmigrationStatus[] = ["refugee_207", "asylee_208"];

type Confidence = "high" | "medium" | "low";

interface FormData {
  language_code: string;
  // Immigration / Identity
  immigration_status: ImmigrationStatus | "";
  has_i94: boolean | null;
  has_ead: boolean | null;
  has_ssn: boolean | null;
  has_orr_eligibility_letter: boolean | null;
  // Key Dates
  eligibility_date: string;
  arrival_date: string;
  status_grant_date: string;
  // Location
  state: string;
  city: string;
  zip_code: string;
  // Household / Income
  age: string;
  household_size: string;
  household_gross_monthly_income: string;
  num_children_under_19: string;
  num_children_under_18: string;
  num_children_under_5: string;
  is_pregnant: boolean | null;
  receives_other_cash_benefit: boolean | null;
  // Special Circumstances
  is_unaccompanied_minor: boolean | null;
  is_disabled: boolean | null;
  is_blind: boolean | null;
  has_40_work_quarters: boolean | null;
  // Goals
  is_employed_or_seeking: boolean | null;
  wants_to_start_business: boolean | null;
  wants_english_classes: boolean | null;
  needs_interpreter: boolean | null;
}

// Document-only fields the engine doesn't store but we display for trust.
interface DocMeta {
  full_name: string;
  country_of_origin: string;
  date_of_birth: string;
}

// Confidence per confirmable field key (from the vision extractor).
type ConfMap = Partial<Record<string, Confidence>>;

// Step IDs. "scan" (upload) and "confirm" (review extracted values) front the
// flow. Date steps + status are SKIPPED in scan mode (handled on the confirm
// screen). orr_letter stays conditional on immigration_status.
type StepId =
  | "language"
  | "scan"
  | "confirm"
  | "status"
  | "documents"
  | "orr_letter"
  | "eligibility_date"
  | "arrival_date"
  | "status_grant_date"
  | "location"
  | "household"
  | "children"
  | "pregnant_cash"
  | "special"
  | "goals";

// scanUsed: true -> document path (confirm + reduced questions);
// false/null -> manual path (full question flow). The "scan" step is where the
// user chooses. Both paths advance to step index 2 after the scan step.
function getSteps(form: FormData, scanUsed: boolean | null): StepId[] {
  const status = form.immigration_status as ImmigrationStatus | "";

  if (scanUsed === true) {
    const steps: StepId[] = ["language", "scan", "confirm", "documents"];
    if (status === "trafficking_victim") steps.push("orr_letter");
    steps.push("location", "household", "children", "pregnant_cash", "special", "goals");
    return steps;
  }

  // Manual path (also used while the user hasn't chosen yet).
  const steps: StepId[] = ["language", "scan", "status", "documents"];
  if (status === "trafficking_victim") steps.push("orr_letter");
  if (status && ORR_STATUSES.includes(status)) steps.push("eligibility_date");
  if (status && status !== "us_citizen") steps.push("arrival_date");
  if (status && STATUS_GRANT_STATUSES.includes(status)) steps.push("status_grant_date");
  steps.push("location", "household", "children", "pregnant_cash", "special", "goals");
  return steps;
}

function ageFromDob(dob: string): string {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age <= 120 ? String(age) : "";
}

export default function OnboardingForm() {
  const router = useRouter();
  const params = useSearchParams();
  const initialLang = params.get("lang") ?? "en";
  const { t, setLanguage } = useTranslation();
  const ob = t.onboarding;

  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Document-scan state.
  const [scanUsed, setScanUsed] = useState<boolean | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [extractNotes, setExtractNotes] = useState<string[]>([]);
  const [detected, setDetected] = useState<string[]>([]);
  const [docMeta, setDocMeta] = useState<DocMeta>({ full_name: "", country_of_origin: "", date_of_birth: "" });
  const [conf, setConf] = useState<ConfMap>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormData>({
    language_code: initialLang,
    immigration_status: "",
    has_i94: null,
    has_ead: null,
    has_ssn: null,
    has_orr_eligibility_letter: null,
    eligibility_date: "",
    arrival_date: "",
    status_grant_date: "",
    state: "",
    city: "",
    zip_code: "",
    age: "",
    household_size: "",
    household_gross_monthly_income: "",
    num_children_under_19: "0",
    num_children_under_18: "0",
    num_children_under_5: "0",
    is_pregnant: null,
    receives_other_cash_benefit: null,
    is_unaccompanied_minor: null,
    is_disabled: null,
    is_blind: null,
    has_40_work_quarters: null,
    is_employed_or_seeking: null,
    wants_to_start_business: null,
    wants_english_classes: null,
    needs_interpreter: null,
  });

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Mark a confirmed (user-touched) field as high confidence so its flag clears.
  function markConfirmed(key: string) {
    setConf((c) => ({ ...c, [key]: "high" }));
  }

  function setChildrenUnder19(raw: string) {
    setForm((f) => {
      const v19 = raw;
      const n19 = parseInt(v19 || "0", 10) || 0;
      if (n19 <= 0) {
        return { ...f, num_children_under_19: v19, num_children_under_18: "0", num_children_under_5: "0" };
      }
      const n18 = Math.min(parseInt(f.num_children_under_18 || "0", 10) || 0, n19);
      const n5 = Math.min(parseInt(f.num_children_under_5 || "0", 10) || 0, n18);
      return {
        ...f,
        num_children_under_19: v19,
        num_children_under_18: String(n18),
        num_children_under_5: String(n5),
      };
    });
  }

  function setChildrenUnder18(raw: string) {
    setForm((f) => {
      const n19 = parseInt(f.num_children_under_19 || "0", 10) || 0;
      const n18 = Math.min(parseInt(raw || "0", 10) || 0, n19);
      const n5 = Math.min(parseInt(f.num_children_under_5 || "0", 10) || 0, n18);
      return { ...f, num_children_under_18: String(n18), num_children_under_5: String(n5) };
    });
  }

  function setChildrenUnder5(raw: string) {
    setForm((f) => {
      const n18 = parseInt(f.num_children_under_18 || "0", 10) || 0;
      const n5 = Math.min(parseInt(raw || "0", 10) || 0, n18);
      return { ...f, num_children_under_5: String(n5) };
    });
  }

  // ── Document extraction ─────────────────────────────────────────────────────
  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).slice(0, 4);
    setFiles(picked);
    setExtractError("");
  }

  function applyExtraction(data: {
    fields?: Record<string, { value: unknown; confidence?: Confidence }>;
    booleans?: { has_i94?: boolean; has_ead?: boolean; has_adjusted_to_lpr?: boolean };
    notes?: string[];
    documents_detected?: string[];
  }) {
    const f = data.fields ?? {};
    const b = data.booleans ?? {};
    const str = (k: string) => (typeof f[k]?.value === "string" ? (f[k]!.value as string) : "");
    const num = (k: string) => (typeof f[k]?.value === "number" ? String(f[k]!.value as number) : "");

    let status = str("immigration_status");
    if (!status && b.has_adjusted_to_lpr) status = "lpr_from_humanitarian";

    setForm((prev) => ({
      ...prev,
      immigration_status: (status || prev.immigration_status) as ImmigrationStatus | "",
      arrival_date: str("arrival_date") || prev.arrival_date,
      eligibility_date: str("eligibility_date") || prev.eligibility_date,
      status_grant_date: str("status_grant_date") || prev.status_grant_date,
      age: num("age") || prev.age,
      has_i94: b.has_i94 ? true : prev.has_i94,
      has_ead: b.has_ead ? true : prev.has_ead,
    }));

    setDocMeta({
      full_name: str("full_name"),
      country_of_origin: str("country_of_origin"),
      date_of_birth: str("date_of_birth"),
    });

    setConf({
      immigration_status: f.immigration_status?.confidence ?? (status ? "medium" : undefined),
      arrival_date: f.arrival_date?.confidence,
      eligibility_date: f.eligibility_date?.confidence,
      status_grant_date: f.status_grant_date?.confidence,
      date_of_birth: f.date_of_birth?.confidence,
      full_name: f.full_name?.confidence,
      country_of_origin: f.country_of_origin?.confidence,
    });

    setExtractNotes(data.notes ?? []);
    setDetected(data.documents_detected ?? []);
  }

  async function runExtract() {
    if (files.length === 0) return;
    setExtracting(true);
    setExtractError("");
    try {
      const fd = new globalThis.FormData();
      files.forEach((f) => fd.append("files", f));
      const res = await fetch("/api/onboarding/extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setExtractError(data.error ?? ob.scan.errorReadFailed);
        setExtracting(false);
        return;
      }
      applyExtraction(data);
      setScanUsed(true);
      setStepIndex(2); // -> "confirm" (index 2 in the scan layout)
    } catch {
      setExtractError(ob.scan.errorUnreachable);
    } finally {
      setExtracting(false);
    }
  }

  function skipScan() {
    setScanUsed(false);
    setStepIndex(2); // -> "status" (index 2 in the manual layout)
  }

  const steps = getSteps(form, scanUsed);
  const currentStep = steps[stepIndex];
  const total = steps.length;
  const progress = Math.round(((stepIndex + 1) / total) * 100);

  function prettyDoc(d: string): string {
    const names = ob.confirm.docNames;
    switch (d) {
      case "i94": return names.i94;
      case "ead": return names.ead;
      case "green_card": return names.green_card;
      case "asylum_letter": return names.asylum_letter;
      case "ssn_card": return names.ssn_card;
      default: return names.other;
    }
  }

  function statusLabel(value: ImmigrationStatus): string {
    return ob.immigrationOptions[value as keyof typeof ob.immigrationOptions]?.label ?? value;
  }
  function statusNote(value: ImmigrationStatus): string | undefined {
    const opt = ob.immigrationOptions[value as keyof typeof ob.immigrationOptions];
    return opt && "note" in opt ? (opt as { note?: string }).note : undefined;
  }

  // Which document-derived fields show on the confirm screen, given the status.
  function confirmFieldKeys(): string[] {
    const status = form.immigration_status as ImmigrationStatus | "";
    const keys = ["immigration_status", "full_name", "date_of_birth", "country_of_origin", "arrival_date"];
    if (!status || ORR_STATUSES.includes(status)) keys.push("eligibility_date");
    if (!status || STATUS_GRANT_STATUSES.includes(status)) keys.push("status_grant_date");
    return keys;
  }
  const lowConfidenceShown = confirmFieldKeys().some((k) => conf[k] === "low");

  function canAdvance(): boolean {
    switch (currentStep) {
      case "language": return !!form.language_code;
      case "scan": return true; // its own buttons drive navigation
      case "confirm": return !!form.immigration_status;
      case "status": return !!form.immigration_status;
      case "documents": return form.has_ssn !== null;
      case "orr_letter": return form.has_orr_eligibility_letter !== null;
      case "eligibility_date": return !!form.eligibility_date;
      case "arrival_date": return !!form.arrival_date;
      case "status_grant_date": return true; // skippable
      case "location": return !!form.state;
      case "household":
        return !!form.age && !!form.household_size && form.household_gross_monthly_income !== "";
      case "children": return true;
      case "pregnant_cash": return form.is_pregnant !== null && form.receives_other_cash_benefit !== null;
      case "special": return (
        form.is_unaccompanied_minor !== null &&
        form.is_disabled !== null &&
        form.is_blind !== null &&
        form.has_40_work_quarters !== null
      );
      case "goals": return (
        form.is_employed_or_seeking !== null &&
        form.wants_to_start_business !== null
      );
      default: return true;
    }
  }

  async function handleFinish() {
    setSaving(true);
    setSaveError("");
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/auth/login"); return; }

    const { data: updatedRows, error: updateError } = await supabase.from("profiles").update({
      language_code: form.language_code,
      immigration_status: form.immigration_status || null,
      has_i94: form.has_i94,
      has_ead: form.has_ead,
      has_ssn: form.has_ssn,
      has_orr_eligibility_letter: form.has_orr_eligibility_letter,
      eligibility_date: form.eligibility_date || null,
      arrival_date: form.arrival_date || null,
      status_grant_date: form.status_grant_date || null,
      state: form.state || null,
      city: form.city || null,
      zip_code: form.zip_code || null,
      age: parseInt(form.age, 10) || null,
      household_size: parseInt(form.household_size, 10) || null,
      household_gross_monthly_income: parseFloat(form.household_gross_monthly_income) || 0,
      num_children_under_19: parseInt(form.num_children_under_19, 10) || 0,
      num_children_under_18: parseInt(form.num_children_under_18, 10) || 0,
      num_children_under_5: parseInt(form.num_children_under_5, 10) || 0,
      is_pregnant: form.is_pregnant ?? false,
      receives_other_cash_benefit: form.receives_other_cash_benefit ?? false,
      is_unaccompanied_minor: form.is_unaccompanied_minor ?? false,
      is_disabled: form.is_disabled ?? false,
      is_blind: form.is_blind ?? false,
      has_40_work_quarters: form.has_40_work_quarters ?? false,
      is_employed_or_seeking: form.is_employed_or_seeking ?? false,
      wants_to_start_business: form.wants_to_start_business ?? false,
      wants_english_classes: form.wants_english_classes ?? false,
      needs_interpreter: form.needs_interpreter ?? false,
      onboarding_complete: true,
    }).eq("id", user.id).select("id");

    // Do NOT advance on a failed save. If we did, `onboarding_complete` would
    // never persist and the dashboard would bounce the user straight back here.
    if (updateError) {
      setSaving(false);
      setSaveError(ob.errors.saveFailed.replace("{message}", updateError.message));
      return;
    }

    if (!updatedRows || updatedRows.length === 0) {
      setSaving(false);
      setSaveError(ob.errors.profileNotFound);
      return;
    }

    router.push("/processing");
  }

  function goNext() {
    if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
    else handleFinish();
  }

  function goBack() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  const todayMax = new Date().toISOString().split("T")[0];
  const dateInputClass =
    "w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus";

  const showNestedChildren = (parseInt(form.num_children_under_19 || "0", 10) || 0) > 0;
  const askAge = !form.age; // hidden once a DOB-derived age is present
  const hideNav = currentStep === "scan"; // the scan step renders its own actions
  const isConfirm = currentStep === "confirm";

  function setDob(v: string) {
    setDocMeta((m) => ({ ...m, date_of_birth: v }));
    set("age", ageFromDob(v));
    markConfirmed("date_of_birth");
    markConfirmed("age");
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      {/* Header / progress */}
      <div className="border-b border-border bg-surface px-4 py-4 md:px-8">
        <div className="mx-auto max-w-lg">
          <div className="mb-2 flex items-center justify-between text-sm text-text-muted">
            <Link href="/" className="flex items-center gap-2 font-display font-semibold text-text">
              <Logo size={26} />
              Wayfinder
            </Link>
            <span aria-live="polite">
              {ob.progressLabel.replace("{current}", String(stepIndex + 1)).replace("{total}", String(total))}
            </span>
          </div>
          <div
            className="h-2.5 w-full overflow-hidden rounded-full bg-sand-200"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Onboarding progress"
          >
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Step content */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 md:px-8">
        <div className="mx-auto w-full max-w-lg">

          {/* ── LANGUAGE ── */}
          {currentStep === "language" && (
            <Step icon="language" question={ob.language.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.language.hint}</p>
              <LanguagePicker
                value={form.language_code}
                onChange={(c) => { set("language_code", c); setLanguage(c); }}
                label=""
              />
            </Step>
          )}

          {/* ── SCAN: upload documents (or skip) ── */}
          {currentStep === "scan" && (
            <Step icon="scan" question={ob.scan.question}>
              <p className="mt-1 mb-4 text-lg text-text-muted">{ob.scan.intro}</p>

              <div className="mb-5 flex items-start gap-2 rounded-[--radius-md] bg-harbor-50 px-4 py-3 text-sm text-harbor-800 ring-1 ring-harbor-100">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{ob.scan.secureLine}</span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                multiple
                onChange={onPickFiles}
                className="sr-only"
                aria-label={ob.scan.uploadAriaLabel}
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-[--radius-md] border-2 border-dashed border-harbor-300 bg-surface px-6 py-10 text-center transition hover:border-harbor-500 hover:bg-harbor-50 focus-visible:outline-none focus-visible:shadow-focus"
              >
                <svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-harbor-500">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="10" r="2" />
                  <path d="M15 9h3" />
                  <path d="M15 13h3" />
                  <path d="M7 15h6" />
                </svg>
                <span className="text-lg font-semibold text-text">
                  {files.length > 0 ? ob.scan.chooseDifferent : ob.scan.chooseFile}
                </span>
                <span className="text-sm text-text-muted">{ob.scan.fileTypes}</span>
              </button>

              {files.length > 0 && (
                <ul className="mt-4 flex flex-col gap-2">
                  {files.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center gap-3 rounded-[--radius-md] border border-border bg-surface-2 px-4 py-3 text-sm text-text"
                    >
                      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-text-muted">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      <span className="flex-1 truncate">{f.name}</span>
                      <span className="text-text-muted">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                    </li>
                  ))}
                </ul>
              )}

              {extractError && (
                <div className="mt-4 rounded-[--radius-md] bg-danger-50 px-4 py-3 text-sm font-medium text-danger-700 ring-1 ring-danger-100">
                  {extractError}
                </div>
              )}

              <div className="mt-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={runExtract}
                  disabled={files.length === 0 || extracting}
                  className="inline-flex items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition active:scale-[0.98] hover:bg-primary-hover hover:shadow-md disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none"
                >
                  {extracting ? ob.scan.reading : `${ob.scan.readDocuments} →`}
                </button>
                <button
                  type="button"
                  onClick={skipScan}
                  disabled={extracting}
                  className="inline-flex items-center justify-center gap-2 rounded-[--radius-md] px-4 py-3 text-base font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none disabled:opacity-40"
                >
                  {ob.scan.skip}
                </button>
                {stepIndex > 0 && (
                  <button
                    type="button"
                    onClick={goBack}
                    disabled={extracting}
                    className="inline-flex items-center justify-center gap-2 rounded-[--radius-md] px-4 py-2 text-sm font-semibold text-text-muted transition hover:text-text focus-visible:outline-none disabled:opacity-40"
                  >
                    ← {ob.nav.back}
                  </button>
                )}
              </div>
            </Step>
          )}

          {/* ── CONFIRM: single reviewable list of everything we read ── */}
          {currentStep === "confirm" && (
            <Step icon="confirm" question={ob.confirm.question}>
              <p className="mt-1 mb-4 text-lg text-text-muted">{ob.confirm.intro}</p>

              <div className="mb-5 flex items-start gap-2 rounded-[--radius-md] bg-harbor-50 px-4 py-3 text-sm text-harbor-800 ring-1 ring-harbor-100">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>
                  {ob.confirm.secureLine}{" "}
                  {detected.length > 0 && (
                    <>{ob.confirm.detectedPrefix} <strong>{detected.map(prettyDoc).join(", ")}</strong>.</>
                  )}
                </span>
              </div>

              {lowConfidenceShown && (
                <div className="mb-5 flex items-start gap-2 rounded-[--radius-md] bg-caution-50 px-4 py-3 text-sm text-caution-700 ring-1 ring-caution-100">
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                  </svg>
                  <span>{ob.confirm.lowConfidence}</span>
                </div>
              )}

              {extractNotes.map((n, i) => (
                <div key={i} className="mb-3 rounded-[--radius-md] bg-sand-100 px-4 py-3 text-sm text-text-muted">
                  {n}
                </div>
              ))}

              <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
                {/* Immigration status — always shown, required */}
                <ConfirmRow label={ob.confirm.fields.immigrationStatus} confidence={conf.immigration_status} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                  <select
                    value={form.immigration_status}
                    onChange={(e) => { set("immigration_status", e.target.value as ImmigrationStatus | ""); markConfirmed("immigration_status"); }}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    aria-label={ob.confirm.fields.immigrationStatus}
                  >
                    <option value="">{ob.confirm.fields.selectStatus}</option>
                    {IMMIGRATION_VALUES.map((v) => <option key={v} value={v}>{statusLabel(v)}</option>)}
                  </select>
                </ConfirmRow>

                <ConfirmRow label={ob.confirm.fields.fullName} hint={ob.confirm.fields.fullNameHint} confidence={conf.full_name} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                  <input
                    type="text"
                    value={docMeta.full_name}
                    onChange={(e) => { setDocMeta((m) => ({ ...m, full_name: e.target.value })); markConfirmed("full_name"); }}
                    placeholder={ob.confirm.fields.fullNamePlaceholder}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    aria-label={ob.confirm.fields.fullName}
                  />
                </ConfirmRow>

                <ConfirmRow label={ob.confirm.fields.dateOfBirth} hint={ob.confirm.fields.dateOfBirthHint} confidence={conf.date_of_birth} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                  <input
                    type="date"
                    value={docMeta.date_of_birth}
                    max={todayMax}
                    onChange={(e) => setDob(e.target.value)}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    aria-label={ob.confirm.fields.dateOfBirth}
                  />
                  {form.age && <p className="mt-1 text-sm text-text-muted">{ob.confirm.fields.age}: {form.age}</p>}
                </ConfirmRow>

                <ConfirmRow label={ob.confirm.fields.countryOfOrigin} hint={ob.confirm.fields.countryOfOriginHint} confidence={conf.country_of_origin} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                  <input
                    type="text"
                    value={docMeta.country_of_origin}
                    onChange={(e) => { setDocMeta((m) => ({ ...m, country_of_origin: e.target.value })); markConfirmed("country_of_origin"); }}
                    placeholder={ob.confirm.fields.countryPlaceholder}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    aria-label={ob.confirm.fields.countryOfOrigin}
                  />
                </ConfirmRow>

                <ConfirmRow label={ob.confirm.fields.arrivalDate} confidence={conf.arrival_date} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                  <input
                    type="date"
                    value={form.arrival_date}
                    max={todayMax}
                    onChange={(e) => { set("arrival_date", e.target.value); markConfirmed("arrival_date"); }}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    aria-label={ob.confirm.fields.arrivalDate}
                  />
                </ConfirmRow>

                {(!form.immigration_status || ORR_STATUSES.includes(form.immigration_status)) && (
                  <ConfirmRow label={ob.confirm.fields.eligibilityDate} hint={ob.confirm.fields.eligibilityDateHint} confidence={conf.eligibility_date} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                    <input
                      type="date"
                      value={form.eligibility_date}
                      max={todayMax}
                      onChange={(e) => { set("eligibility_date", e.target.value); markConfirmed("eligibility_date"); }}
                      className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                      aria-label={ob.confirm.fields.eligibilityDate}
                    />
                  </ConfirmRow>
                )}

                {(!form.immigration_status || STATUS_GRANT_STATUSES.includes(form.immigration_status)) && (
                  <ConfirmRow label={ob.confirm.fields.statusGrantDate} hint={ob.confirm.fields.statusGrantDateHint} confidence={conf.status_grant_date} please={ob.confirm.pleaseCheck} fromDoc={ob.confirm.fromDocument}>
                    <input
                      type="date"
                      value={form.status_grant_date}
                      max={todayMax}
                      onChange={(e) => { set("status_grant_date", e.target.value); markConfirmed("status_grant_date"); }}
                      className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                      aria-label={ob.confirm.fields.statusGrantDate}
                    />
                  </ConfirmRow>
                )}
              </div>
            </Step>
          )}

          {/* ── IMMIGRATION STATUS (manual path) ── */}
          {currentStep === "status" && (
            <Step icon="status" question={ob.status.question}>
              <p className="mt-1 mb-4 text-lg text-text-muted">{ob.status.hint}</p>
              <div className="flex flex-col gap-2">
                {IMMIGRATION_VALUES.map((value) => {
                  const selected = form.immigration_status === value;
                  const label = statusLabel(value);
                  const note = statusNote(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => set("immigration_status", value)}
                      className={
                        selected
                          ? "flex items-start gap-3 rounded-[--radius-md] border-2 border-harbor-500 bg-harbor-50 px-4 py-4 text-left text-base font-semibold text-harbor-800 transition"
                          : "flex items-start gap-3 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-left text-base font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none"
                      }
                    >
                      <span className="flex-1">
                        <span className="block">{label}</span>
                        {note && (
                          <span className={`mt-0.5 block text-sm font-normal ${selected ? "text-harbor-700" : "text-text-muted"}`}>
                            {note}
                          </span>
                        )}
                      </span>
                      {selected && (
                        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-harbor-600">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </Step>
          )}

          {/* ── DOCUMENTS (SSN always; I-94/EAD only when not from a scan) ── */}
          {currentStep === "documents" && (
            <Step icon="documents" question={ob.documents.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.documents.hint}</p>
              {scanUsed && (form.has_i94 || form.has_ead) && (
                <div className="mb-4 flex items-start gap-2 rounded-[--radius-md] bg-success-50 px-4 py-3 text-sm text-success-700 ring-1 ring-success-100">
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span>{ob.documents.fromDocsPrefix}{form.has_i94 ? ob.documents.fromDocsI94 : ""}{form.has_i94 && form.has_ead ? ob.documents.fromDocsAnd : ""}{form.has_ead ? ob.documents.fromDocsEad : ""}.</span>
                </div>
              )}
              <div className="flex flex-col gap-4">
                {!scanUsed && (
                  <>
                    <DocYesNo
                      label={ob.documents.i94Label}
                      hint={ob.documents.i94Hint}
                      value={form.has_i94}
                      onChange={(v) => set("has_i94", v)}
                      yes={ob.yes}
                      no={ob.no}
                    />
                    <DocYesNo
                      label={ob.documents.eadLabel}
                      hint={ob.documents.eadHint}
                      value={form.has_ead}
                      onChange={(v) => set("has_ead", v)}
                      yes={ob.yes}
                      no={ob.no}
                    />
                  </>
                )}
                <DocYesNo
                  label={ob.documents.ssnLabel}
                  hint={ob.documents.ssnHint}
                  value={form.has_ssn}
                  onChange={(v) => set("has_ssn", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
              </div>
            </Step>
          )}

          {/* ── ORR ELIGIBILITY LETTER (trafficking victims only) ── */}
          {currentStep === "orr_letter" && (
            <Step icon="orr_letter" question={ob.orrLetter.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.orrLetter.hint}</p>
              <YesNo value={form.has_orr_eligibility_letter} onChange={(v) => set("has_orr_eligibility_letter", v)} yes={ob.yes} no={ob.no} />
            </Step>
          )}

          {/* ── ELIGIBILITY DATE (manual path) ── */}
          {currentStep === "eligibility_date" && (
            <Step icon="eligibility_date" question={ob.eligibilityDate.question}>
              <p className="mt-1 mb-3 text-lg text-text-muted">{ob.eligibilityDate.hint}</p>
              <div className="mb-4 flex items-start gap-2 rounded-[--radius-md] bg-caution-50 px-4 py-3 text-sm text-caution-700 ring-1 ring-caution-100">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                  <circle cx="12" cy="13" r="8" />
                  <path d="M12 9v4l2 2" />
                  <path d="M5 3 2 6" />
                  <path d="m22 6-3-3" />
                </svg>
                <span><strong>{ob.eligibilityDate.deadlineLabel}</strong>{ob.eligibilityDate.deadlineBody}</span>
              </div>
              <input
                type="date"
                value={form.eligibility_date}
                max={todayMax}
                onChange={(e) => set("eligibility_date", e.target.value)}
                className={dateInputClass}
                aria-label={ob.confirm.fields.eligibilityDate}
              />
            </Step>
          )}

          {/* ── ARRIVAL DATE (manual path) ── */}
          {currentStep === "arrival_date" && (
            <Step icon="arrival_date" question={ob.arrivalDate.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.arrivalDate.hint}</p>
              <input
                type="date"
                value={form.arrival_date}
                max={todayMax}
                onChange={(e) => set("arrival_date", e.target.value)}
                className={dateInputClass}
                aria-label={ob.confirm.fields.arrivalDate}
              />
            </Step>
          )}

          {/* ── STATUS GRANT DATE (refugee_207 / asylee_208, manual path) ── */}
          {currentStep === "status_grant_date" && (
            <Step icon="status_grant_date" question={ob.statusGrantDate.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.statusGrantDate.hint}</p>
              <input
                type="date"
                value={form.status_grant_date}
                max={todayMax}
                onChange={(e) => set("status_grant_date", e.target.value)}
                className={dateInputClass}
                aria-label={ob.confirm.fields.statusGrantDate}
              />
              <button
                type="button"
                onClick={goNext}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-[--radius-md] px-4 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
              >
                {ob.nav.skipNotSure}
              </button>
            </Step>
          )}

          {/* ── LOCATION ── */}
          {currentStep === "location" && (
            <Step icon="location" question={ob.location.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.location.hint}</p>
              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="ob-state" className="mb-1.5 block text-sm font-semibold text-text-muted">{ob.location.stateLabel}</label>
                  <select
                    id="ob-state"
                    value={form.state}
                    onChange={(e) => set("state", e.target.value)}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                  >
                    <option value="">{ob.location.selectState}</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="ob-city" className="mb-1.5 block text-sm font-semibold text-text-muted">{ob.location.cityLabel}</label>
                  <input
                    id="ob-city"
                    type="text"
                    value={form.city}
                    onChange={(e) => set("city", e.target.value)}
                    placeholder={ob.location.cityPlaceholder}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                  />
                </div>
                <div>
                  <label htmlFor="ob-zip" className="mb-1.5 block text-sm font-semibold text-text-muted">{ob.location.zipLabel}</label>
                  <input
                    id="ob-zip"
                    type="text"
                    inputMode="numeric"
                    value={form.zip_code}
                    onChange={(e) => set("zip_code", e.target.value)}
                    placeholder={ob.location.zipPlaceholder}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                  />
                </div>
              </div>
            </Step>
          )}

          {/* ── HOUSEHOLD (age shown only when not already known from a document) ── */}
          {currentStep === "household" && (
            <Step icon="household" question={ob.household.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.household.hint}</p>
              <div className="flex flex-col gap-6">
                {askAge ? (
                  <div>
                    <label htmlFor="ob-age" className="mb-1.5 block text-sm font-semibold text-text-muted">{ob.household.ageLabel}</label>
                    <input
                      id="ob-age"
                      autoFocus
                      type="number"
                      min={0}
                      max={120}
                      value={form.age}
                      onChange={(e) => set("age", e.target.value)}
                      placeholder={ob.household.agePlaceholder}
                      className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-2xl text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    />
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-[--radius-md] bg-success-50 px-4 py-3 text-sm text-success-700 ring-1 ring-success-100">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span>{ob.household.ageFromDoc.replace("{age}", form.age)}</span>
                  </div>
                )}
                <div>
                  <label htmlFor="ob-hh-size" className="mb-1.5 block text-sm font-semibold text-text-muted">
                    {ob.household.sizeLabel}
                  </label>
                  <input
                    id="ob-hh-size"
                    type="number"
                    min={1}
                    max={20}
                    value={form.household_size}
                    onChange={(e) => set("household_size", e.target.value)}
                    placeholder={ob.household.sizePlaceholder}
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-2xl text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                  />
                </div>
                <div>
                  <label htmlFor="ob-income" className="mb-1.5 block text-sm font-semibold text-text-muted">
                    {ob.household.incomeLabel}
                  </label>
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="text-2xl font-bold text-text-muted">$</span>
                    <input
                      id="ob-income"
                      type="number"
                      min={0}
                      value={form.household_gross_monthly_income}
                      onChange={(e) => set("household_gross_monthly_income", e.target.value)}
                      placeholder={ob.household.incomePlaceholder}
                      className="flex-1 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-2xl text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                    />
                    <span className="text-text-muted">{ob.household.perMonth}</span>
                  </div>
                </div>
              </div>
            </Step>
          )}

          {/* ── CHILDREN (age-bucket-safe subsets) ── */}
          {currentStep === "children" && (
            <Step icon="children" question={ob.children.question}>
              <div className="flex flex-col gap-5">
                <NumberInput
                  label={ob.children.under19Label}
                  hint={ob.children.under19Hint}
                  value={form.num_children_under_19}
                  onChange={setChildrenUnder19}
                  max={20}
                />
                {showNestedChildren && (
                  <>
                    <NumberInput
                      label={ob.children.under18Label}
                      hint={ob.children.subsetHint}
                      value={form.num_children_under_18}
                      onChange={setChildrenUnder18}
                      max={parseInt(form.num_children_under_19 || "0", 10) || 0}
                    />
                    <NumberInput
                      label={ob.children.under5Label}
                      hint={ob.children.subsetHint}
                      value={form.num_children_under_5}
                      onChange={setChildrenUnder5}
                      max={parseInt(form.num_children_under_18 || "0", 10) || 0}
                    />
                  </>
                )}
              </div>
            </Step>
          )}

          {/* ── PREGNANT + CASH BENEFITS ── */}
          {currentStep === "pregnant_cash" && (
            <Step icon="pregnant_cash" question={ob.pregnantCash.question}>
              <div className="mt-2 flex flex-col gap-8">
                <div>
                  <p className="mb-3 text-lg font-bold text-text">
                    {ob.pregnantCash.pregnantLabel}
                  </p>
                  <p className="mb-4 text-sm text-text-muted">{ob.pregnantCash.pregnantHint}</p>
                  <YesNo value={form.is_pregnant} onChange={(v) => set("is_pregnant", v)} yes={ob.yes} no={ob.no} />
                </div>
                <div className="border-t border-border pt-6">
                  <p className="mb-3 text-lg font-bold text-text">
                    {ob.pregnantCash.cashLabel}
                  </p>
                  <p className="mb-4 text-sm text-text-muted">
                    {ob.pregnantCash.cashHint}
                  </p>
                  <YesNo value={form.receives_other_cash_benefit} onChange={(v) => set("receives_other_cash_benefit", v)} yes={ob.yes} no={ob.no} />
                </div>
              </div>
            </Step>
          )}

          {/* ── SPECIAL CIRCUMSTANCES ── */}
          {currentStep === "special" && (
            <Step icon="special" question={ob.special.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.special.hint}</p>
              <div className="flex flex-col gap-4">
                <DocYesNo
                  label={ob.special.unaccompaniedLabel}
                  hint={ob.special.unaccompaniedHint}
                  value={form.is_unaccompanied_minor}
                  onChange={(v) => set("is_unaccompanied_minor", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.special.disabledLabel}
                  hint={ob.special.disabledHint}
                  value={form.is_disabled}
                  onChange={(v) => set("is_disabled", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.special.blindLabel}
                  hint={ob.special.blindHint}
                  value={form.is_blind}
                  onChange={(v) => set("is_blind", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.special.workQuartersLabel}
                  hint={ob.special.workQuartersHint}
                  value={form.has_40_work_quarters}
                  onChange={(v) => set("has_40_work_quarters", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
              </div>
            </Step>
          )}

          {/* ── GOALS ── */}
          {currentStep === "goals" && (
            <Step icon="goals" question={ob.goals.question}>
              <p className="mt-1 mb-6 text-lg text-text-muted">{ob.goals.hint}</p>
              <div className="flex flex-col gap-4">
                <DocYesNo
                  label={ob.goals.employmentLabel}
                  hint={ob.goals.employmentHint}
                  value={form.is_employed_or_seeking}
                  onChange={(v) => set("is_employed_or_seeking", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.goals.businessLabel}
                  hint={ob.goals.businessHint}
                  value={form.wants_to_start_business}
                  onChange={(v) => set("wants_to_start_business", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.goals.englishLabel}
                  hint={ob.goals.englishHint}
                  value={form.wants_english_classes}
                  onChange={(v) => set("wants_english_classes", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
                <DocYesNo
                  label={ob.goals.interpreterLabel}
                  hint={ob.goals.interpreterHint}
                  value={form.needs_interpreter}
                  onChange={(v) => set("needs_interpreter", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
              </div>
            </Step>
          )}

          {saveError && (
            <div className="mt-8 rounded-[--radius-md] bg-danger-50 px-4 py-3 text-sm font-medium text-danger-700 ring-1 ring-danger-100">
              {saveError}
            </div>
          )}

          {/* Navigation */}
          {!hideNav && (
            <div className="mt-10 flex items-center gap-4">
              {stepIndex > 0 && (
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-6 py-4 text-lg font-semibold text-harbor-700 transition active:scale-[0.98] hover:border-harbor-500 hover:bg-harbor-50 focus-visible:outline-none"
                >
                  ← {ob.nav.back}
                </button>
              )}
              {stepIndex < steps.length - 1 ? (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canAdvance()}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition active:scale-[0.98] hover:bg-primary-hover hover:shadow-md disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none"
                >
                  {isConfirm ? `${ob.nav.confirmContinue} →` : `${ob.nav.next} →`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={saving || !canAdvance()}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] bg-success-600 px-5 py-4 text-lg font-semibold text-white shadow-sm transition active:scale-[0.98] hover:bg-success-700 hover:shadow-md disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none"
                >
                  {saving ? ob.nav.saving : `${ob.nav.findBenefits} →`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

// Inline SVG step icons, keyed by step. Purely decorative (aria-hidden on the
// wrapper). Stroke inherits via currentColor.
type StepIconKey =
  | "language"
  | "scan"
  | "confirm"
  | "status"
  | "documents"
  | "orr_letter"
  | "eligibility_date"
  | "arrival_date"
  | "status_grant_date"
  | "location"
  | "household"
  | "children"
  | "pregnant_cash"
  | "special"
  | "goals";

const STEP_ICONS: Record<StepIconKey, React.ReactNode> = {
  language: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  scan: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  confirm: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </>
  ),
  status: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  documents: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M15 9h3" />
      <path d="M15 13h3" />
      <path d="M7 15h6" />
    </>
  ),
  orr_letter: (
    <>
      <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  eligibility_date: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </>
  ),
  arrival_date: <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />,
  status_grant_date: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </>
  ),
  location: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  household: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  children: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  pregnant_cash: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 8v5" />
      <path d="M12 13c3 0 4 2.5 4 5v3h-3" />
      <path d="M12 13c-1.5 0-2.5 1-2.5 2.5S10 18 12 18" />
    </>
  ),
  special: <path d="M12 2l2.9 6.3 6.9.7-5.1 4.7 1.4 6.8L12 17.8 5.9 20.5l1.4-6.8L2.2 9l6.9-.7z" />,
  goals: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
};

function Step({ icon, question, children }: { icon: StepIconKey; question: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        aria-hidden="true"
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-harbor-50 text-harbor-600"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {STEP_ICONS[icon]}
        </svg>
      </div>
      <h2 className="font-display text-2xl font-semibold text-text md:text-3xl">{question}</h2>
      {children}
    </div>
  );
}

function ConfirmRow({
  label, hint, confidence, children, please, fromDoc,
}: { label: string; hint?: string; confidence?: Confidence; children: React.ReactNode; please: string; fromDoc: string }) {
  const low = confidence === "low";
  return (
    <div className={`rounded-[--radius-md] border p-4 ${low ? "border-caution-300 bg-caution-50" : "border-border bg-surface"}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="font-semibold text-text">{label}</label>
        {low ? (
          <span className="rounded-full bg-caution-100 px-2.5 py-0.5 text-xs font-semibold text-caution-700">{please}</span>
        ) : confidence ? (
          <span className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs font-medium text-text-muted">{fromDoc}</span>
        ) : null}
      </div>
      {hint && <p className="mb-2 text-sm text-text-muted">{hint}</p>}
      {children}
    </div>
  );
}

function YesNo({ value, onChange, yes, no }: { value: boolean | null; onChange: (v: boolean) => void; yes: string; no: string }) {
  return (
    <div className="flex gap-4">
      <button
        type="button"
        aria-pressed={value === true}
        onClick={() => onChange(true)}
        className={
          value === true
            ? "flex flex-1 items-center justify-center gap-3 rounded-[--radius-md] border-2 border-harbor-500 bg-harbor-50 px-4 py-5 text-center text-xl font-semibold text-harbor-800 transition"
            : "flex flex-1 items-center justify-center gap-3 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-5 text-center text-xl font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none"
        }
      >
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        {yes}
      </button>
      <button
        type="button"
        aria-pressed={value === false}
        onClick={() => onChange(false)}
        className={
          value === false
            ? "flex flex-1 items-center justify-center gap-3 rounded-[--radius-md] border-2 border-harbor-500 bg-harbor-50 px-4 py-5 text-center text-xl font-semibold text-harbor-800 transition"
            : "flex flex-1 items-center justify-center gap-3 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-5 text-center text-xl font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none"
        }
      >
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
        {no}
      </button>
    </div>
  );
}

function DocYesNo({ label, hint, value, onChange, yes, no }: {
  label: string; hint?: string; value: boolean | null; onChange: (v: boolean) => void; yes: string; no: string;
}) {
  return (
    <div className="rounded-[--radius-md] border border-border bg-surface p-4">
      <p className="mb-1 font-semibold text-text">{label}</p>
      {hint && <p className="mb-3 text-sm text-text-muted">{hint}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          aria-pressed={value === true}
          onClick={() => onChange(true)}
          className={
            value === true
              ? "flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-500 bg-harbor-50 px-4 py-2.5 text-base font-semibold text-harbor-800 transition"
              : "flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface-2 px-4 py-2.5 text-base font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none"
          }
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          {yes}
        </button>
        <button
          type="button"
          aria-pressed={value === false}
          onClick={() => onChange(false)}
          className={
            value === false
              ? "flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-500 bg-harbor-50 px-4 py-2.5 text-base font-semibold text-harbor-800 transition"
              : "flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface-2 px-4 py-2.5 text-base font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none"
          }
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
          {no}
        </button>
      </div>
    </div>
  );
}

function NumberInput({ label, hint, value, onChange, max = 20 }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; max?: number;
}) {
  return (
    <div className="rounded-[--radius-md] border border-border bg-surface p-4">
      <label className="mb-1 block font-semibold text-text">{label}</label>
      {hint && <p className="mb-2 text-sm text-text-muted">{hint}</p>}
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[--radius-md] border-2 border-border bg-surface-2 px-4 py-3 text-xl text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
      />
    </div>
  );
}
