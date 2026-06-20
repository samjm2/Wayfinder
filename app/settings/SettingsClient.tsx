"use client";

// Settings client. Two areas:
//  1) LANGUAGE — wired to the provider's setLanguage so the whole app updates
//     LIVE (no reload). After a successful change we also POST /api/eligibility
//     (re-run the deterministic engine so the AI summary/steps come back in the
//     new language) and router.refresh() so the dashboard's server-rendered
//     result picks up the new row.
//  2) EDIT MY INFORMATION — the onboarding intake fields, pre-filled from the
//     current profile. On Save we update `profiles`, then route to /processing
//     which re-runs /api/eligibility (the deterministic engine) and lands on the
//     dashboard. We do NOT reimplement eligibility here.
//
// Sensitive numbers (SSN, A-Number, etc.) are never collected — we only ask
// yes/no about whether the user has an SSN, exactly as onboarding does.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";
import LanguagePicker from "@/components/LanguagePicker";
import AutofillSetup from "@/components/AutofillSetup";
import { createClient } from "@/lib/supabase/client";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import type { ImmigrationStatus, Profile, Document } from "@/lib/types";
import { profileToValues, mergeDocumentFields, type ProfileValues } from "@/lib/formFill";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

// Mirrors app/onboarding/OnboardingForm.tsx. Labels/notes are read from the
// shared t.onboarding.immigrationOptions map so this editor is fully translated.
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

const ORR_STATUSES: ImmigrationStatus[] = [
  "refugee_207", "asylee_208", "siv", "afghan_parolee",
  "cuban_haitian_entrant", "trafficking_victim", "amerasian",
];
const STATUS_GRANT_STATUSES: ImmigrationStatus[] = ["refugee_207", "asylee_208"];

interface FormData {
  immigration_status: ImmigrationStatus | "";
  has_i94: boolean | null;
  has_ead: boolean | null;
  has_ssn: boolean | null;
  has_orr_eligibility_letter: boolean | null;
  eligibility_date: string;
  arrival_date: string;
  status_grant_date: string;
  state: string;
  city: string;
  zip_code: string;
  age: string;
  household_size: string;
  household_gross_monthly_income: string;
  num_children_under_19: string;
  num_children_under_18: string;
  num_children_under_5: string;
  is_pregnant: boolean | null;
  receives_other_cash_benefit: boolean | null;
  is_unaccompanied_minor: boolean | null;
  is_disabled: boolean | null;
  is_blind: boolean | null;
  has_40_work_quarters: boolean | null;
  is_employed_or_seeking: boolean | null;
  wants_to_start_business: boolean | null;
  wants_english_classes: boolean | null;
  needs_interpreter: boolean | null;
}

function profileToForm(p: Profile): FormData {
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return {
    immigration_status: (p.immigration_status ?? "") as ImmigrationStatus | "",
    has_i94: p.has_i94,
    has_ead: p.has_ead,
    has_ssn: p.has_ssn,
    has_orr_eligibility_letter: p.has_orr_eligibility_letter,
    eligibility_date: p.eligibility_date ?? "",
    arrival_date: p.arrival_date ?? "",
    status_grant_date: p.status_grant_date ?? "",
    state: p.state ?? "",
    city: p.city ?? "",
    zip_code: p.zip_code ?? "",
    age: num(p.age),
    household_size: num(p.household_size),
    household_gross_monthly_income: num(p.household_gross_monthly_income),
    num_children_under_19: num(p.num_children_under_19) || "0",
    num_children_under_18: num(p.num_children_under_18) || "0",
    num_children_under_5: num(p.num_children_under_5) || "0",
    is_pregnant: p.is_pregnant,
    receives_other_cash_benefit: p.receives_other_cash_benefit,
    is_unaccompanied_minor: p.is_unaccompanied_minor,
    is_disabled: p.is_disabled,
    is_blind: p.is_blind,
    has_40_work_quarters: p.has_40_work_quarters,
    is_employed_or_seeking: p.is_employed_or_seeking,
    wants_to_start_business: p.wants_to_start_business,
    wants_english_classes: p.wants_english_classes,
    needs_interpreter: p.needs_interpreter,
  };
}

// What Wayfinder has learned about the user, merged the same way the autofill
// agent merges it: saved profile first, then each uploaded document (newest
// first). Sensitive numbers are never part of this.
const MEMORY_LABELS: { key: keyof ProfileValues; label: string }[] = [
  { key: "fullName", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "dateOfBirth", label: "Date of birth" },
  { key: "age", label: "Age" },
  { key: "countryOfBirth", label: "Country of birth" },
  { key: "address", label: "Street address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP code" },
  { key: "phone", label: "Phone" },
  { key: "arrivalDate", label: "Date of entry" },
  { key: "householdSize", label: "Household size" },
];

export default function SettingsClient({
  profile,
  documents,
  embedded = false,
}: {
  profile: Profile;
  documents?: Document[];
  embedded?: boolean;
}) {
  const router = useRouter();
  const { t, lang, translating, setLanguage } = useTranslation();
  const ob = t.onboarding;

  // Merge profile + all documents (newest first) into the "memory" the autofill
  // agent uses, so the user can see and verify it.
  const memory = (() => {
    let v = profileToValues(profile);
    for (const d of documents ?? []) {
      v = mergeDocumentFields(v, d.extracted_fields as Record<string, string> | null | undefined);
    }
    return v;
  })();
  const memoryEntries = MEMORY_LABELS
    .map(({ key, label }) => ({ label, value: memory[key] }))
    .filter((e): e is { label: string; value: string } => !!e.value);

  function statusOptionText(value: ImmigrationStatus): string {
    const opt = ob.immigrationOptions[value as keyof typeof ob.immigrationOptions];
    if (!opt) return value;
    const note = "note" in opt ? (opt as { note?: string }).note : undefined;
    return note ? `${opt.label} — ${note}` : opt.label;
  }

  // ── Language area ──

  async function onChangeLanguage(code: string) {
    if (code === lang) return;
    // Switch the UI live (fetches /api/translate for non-English, updates html
    // lang/dir, persists to profile + localStorage). No API eligibility call.
    await setLanguage(code);
    router.refresh();
  }

  // ── Edit-info area ──
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(() => profileToForm(profile));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedSuccess, setSavedSuccess] = useState(false);

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Keep the child age buckets nested (under-5 <= under-18 <= under-19).
  function setChildrenUnder19(raw: string) {
    setForm((f) => {
      const n19 = parseInt(raw || "0", 10) || 0;
      if (n19 <= 0) return { ...f, num_children_under_19: raw, num_children_under_18: "0", num_children_under_5: "0" };
      const n18 = Math.min(parseInt(f.num_children_under_18 || "0", 10) || 0, n19);
      const n5 = Math.min(parseInt(f.num_children_under_5 || "0", 10) || 0, n18);
      return { ...f, num_children_under_19: raw, num_children_under_18: String(n18), num_children_under_5: String(n5) };
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

  const status = form.immigration_status as ImmigrationStatus | "";
  const showEligibilityDate = !status || ORR_STATUSES.includes(status);
  const showArrivalDate = !status || status !== "us_citizen";
  const showStatusGrantDate = !status || STATUS_GRANT_STATUSES.includes(status);
  const showNestedChildren = (parseInt(form.num_children_under_19 || "0", 10) || 0) > 0;
  const todayMax = new Date().toISOString().split("T")[0];

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.push("/auth/login?redirectTo=/settings");
      return;
    }

    const { data: updatedRows, error } = await supabase.from("profiles").update({
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

    if (error) {
      setSaving(false);
      setSaveError(error.message);
      return;
    }
    if (!updatedRows || updatedRows.length === 0) {
      setSaving(false);
      setSaveError(ob.errors.profileNotFoundShort);
      return;
    }

    setSaving(false);
    setSavedSuccess(true);
    setEditing(false);
  }

  const fieldClass =
    "w-full rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus";

  const body = (
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 md:px-8">
        <h1 className="font-display text-3xl font-semibold text-text">{t.dashboard.settings.title}</h1>
        <p className="mt-2 text-lg text-text-muted">{t.dashboard.settings.subtitle}</p>

        {/* ── WHAT WAYFINDER KNOWS (the agent's memory) ── */}
        <section className="mt-8 rounded-[--radius-md] border border-border bg-surface p-5 shadow-sm md:p-6">
          <h2 className="text-xl font-semibold text-text">What Wayfinder knows about you</h2>
          <p className="mt-1 text-base text-text-muted">
            This is the information the AI uses to fill forms — combined from your answers and the documents you uploaded. Sensitive numbers (SSN, A-Number, passport, bank) are never stored here.
          </p>
          {memoryEntries.length > 0 ? (
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {memoryEntries.map((e) => (
                <div key={e.label} className="rounded-[--radius-md] bg-surface-2 px-4 py-2.5">
                  <dt className="text-xs font-medium text-text-faint">{e.label}</dt>
                  <dd className="text-base font-semibold text-text">{e.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-4 rounded-[--radius-md] bg-surface-2 px-4 py-3 text-sm text-text-muted">
              Nothing yet. Add your documents in <strong>My Documents</strong> (or finish onboarding) and they&apos;ll appear here.
            </p>
          )}
        </section>

        {/* ── LANGUAGE ── */}
        <section className="mt-8 rounded-[--radius-md] border border-border bg-surface p-5 shadow-sm md:p-6">
          <h2 className="text-xl font-semibold text-text">{t.dashboard.settings.language}</h2>
          <p className="mt-1 mb-4 text-base text-text-muted">{t.dashboard.settings.languageHint}</p>
          <LanguagePicker value={lang} onChange={onChangeLanguage} label="" />
          {translating && (
            <p className="mt-3 flex items-center gap-2 text-sm text-text-muted" aria-live="polite">
              <span aria-hidden="true">
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              </span>
              {t.dashboard.settings.saving}
            </p>
          )}
        </section>

        {/* ── EDIT MY INFORMATION ── */}
        <section className="mt-6 rounded-[--radius-md] border border-border bg-surface p-5 shadow-sm md:p-6">
          <h2 className="text-xl font-semibold text-text">{t.dashboard.settings.editInfo}</h2>
          <p className="mt-1 text-base text-text-muted">{t.dashboard.settings.editInfoHint}</p>

          {savedSuccess && !editing && (
            <div className="mt-4 rounded-[--radius-md] bg-success-50 px-4 py-3 text-sm font-medium text-success-700 ring-1 ring-success-100">
              {t.dashboard.settings.saved}
            </div>
          )}

          {!editing ? (
            <button
              type="button"
              onClick={() => { setForm(profileToForm(profile)); setEditing(true); setSavedSuccess(false); }}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-5 py-3 text-base font-semibold text-harbor-700 transition active:scale-[0.98] hover:border-harbor-500 hover:bg-harbor-50 focus-visible:outline-none focus-visible:shadow-focus"
            >
              {t.common.edit}
            </button>
          ) : (
            <div className="mt-6 flex flex-col gap-6">
              {/* Immigration status */}
              <Field label={ob.status.question}>
                <select
                  value={form.immigration_status}
                  onChange={(e) => set("immigration_status", e.target.value as ImmigrationStatus | "")}
                  className={fieldClass}
                  aria-label={ob.confirm.fields.immigrationStatus}
                >
                  <option value="">{ob.confirm.fields.selectStatus}</option>
                  {IMMIGRATION_VALUES.map((v) => (
                    <option key={v} value={v}>{statusOptionText(v)}</option>
                  ))}
                </select>
              </Field>

              {/* Documents (yes/no only — never the numbers themselves) */}
              <YesNoField
                label={ob.settingsForm.i94Label}
                value={form.has_i94}
                onChange={(v) => set("has_i94", v)}
                yes={ob.yes}
                no={ob.no}
              />
              <YesNoField
                label={ob.settingsForm.eadLabel}
                value={form.has_ead}
                onChange={(v) => set("has_ead", v)}
                yes={ob.yes}
                no={ob.no}
              />
              <YesNoField
                label={ob.documents.ssnLabel}
                hint={ob.documents.ssnHint}
                value={form.has_ssn}
                onChange={(v) => set("has_ssn", v)}
                yes={ob.yes}
                no={ob.no}
              />
              {status === "trafficking_victim" && (
                <YesNoField
                  label={ob.orrLetter.question}
                  value={form.has_orr_eligibility_letter}
                  onChange={(v) => set("has_orr_eligibility_letter", v)}
                  yes={ob.yes}
                  no={ob.no}
                />
              )}

              {/* Dates */}
              {showEligibilityDate && (
                <Field label={ob.settingsForm.eligibilityDateLabel}>
                  <input type="date" value={form.eligibility_date} max={todayMax}
                    onChange={(e) => set("eligibility_date", e.target.value)} className={fieldClass} aria-label={ob.confirm.fields.eligibilityDate} />
                </Field>
              )}
              {showArrivalDate && (
                <Field label={ob.settingsForm.arrivalDateLabel}>
                  <input type="date" value={form.arrival_date} max={todayMax}
                    onChange={(e) => set("arrival_date", e.target.value)} className={fieldClass} aria-label={ob.confirm.fields.arrivalDate} />
                </Field>
              )}
              {showStatusGrantDate && (
                <Field label={ob.settingsForm.statusGrantDateLabel}>
                  <input type="date" value={form.status_grant_date} max={todayMax}
                    onChange={(e) => set("status_grant_date", e.target.value)} className={fieldClass} aria-label={ob.confirm.fields.statusGrantDate} />
                </Field>
              )}

              {/* Location */}
              <Field label={ob.location.question}>
                <select value={form.state} onChange={(e) => set("state", e.target.value)} className={fieldClass} aria-label={ob.location.stateLabel}>
                  <option value="">{ob.location.selectState}</option>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label={ob.location.cityLabel}>
                <input type="text" value={form.city} onChange={(e) => set("city", e.target.value)} placeholder={ob.location.cityPlaceholder} className={fieldClass} aria-label={ob.location.cityLabel} />
              </Field>
              <Field label={ob.location.zipLabel}>
                <input type="text" inputMode="numeric" value={form.zip_code} onChange={(e) => set("zip_code", e.target.value)} placeholder={ob.location.zipPlaceholder} className={fieldClass} aria-label={ob.location.zipLabel} />
              </Field>

              {/* Household */}
              <Field label={ob.household.ageLabel}>
                <input type="number" min={0} max={120} value={form.age} onChange={(e) => set("age", e.target.value)} placeholder={ob.household.agePlaceholder} className={fieldClass} aria-label={ob.household.ageLabel} />
              </Field>
              <Field label={ob.household.sizeLabel}>
                <input type="number" min={1} max={20} value={form.household_size} onChange={(e) => set("household_size", e.target.value)} placeholder={ob.household.sizePlaceholder} className={fieldClass} aria-label={ob.household.sizeLabel} />
              </Field>
              <Field label={ob.household.incomeLabel}>
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="text-xl font-bold text-text-muted">$</span>
                  <input type="number" min={0} value={form.household_gross_monthly_income}
                    onChange={(e) => set("household_gross_monthly_income", e.target.value)} placeholder={ob.household.incomePlaceholder}
                    className={`flex-1 ${fieldClass}`} aria-label={ob.household.incomeLabel} />
                  <span className="text-text-muted">{ob.household.perMonth}</span>
                </div>
              </Field>

              {/* Children */}
              <Field label={ob.children.under19Label}>
                <input type="number" min={0} max={20} value={form.num_children_under_19} onChange={(e) => setChildrenUnder19(e.target.value)} className={fieldClass} aria-label={ob.children.under19Label} />
              </Field>
              {showNestedChildren && (
                <>
                  <Field label={ob.children.under18Label}>
                    <input type="number" min={0} max={parseInt(form.num_children_under_19 || "0", 10) || 0}
                      value={form.num_children_under_18} onChange={(e) => setChildrenUnder18(e.target.value)} className={fieldClass} aria-label={ob.children.under18Label} />
                  </Field>
                  <Field label={ob.children.under5Label}>
                    <input type="number" min={0} max={parseInt(form.num_children_under_18 || "0", 10) || 0}
                      value={form.num_children_under_5} onChange={(e) => setChildrenUnder5(e.target.value)} className={fieldClass} aria-label={ob.children.under5Label} />
                  </Field>
                </>
              )}

              {/* Pregnant + cash */}
              <YesNoField label={ob.pregnantCash.pregnantLabel} value={form.is_pregnant} onChange={(v) => set("is_pregnant", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.pregnantCash.cashLabel} value={form.receives_other_cash_benefit} onChange={(v) => set("receives_other_cash_benefit", v)} yes={ob.yes} no={ob.no} />

              {/* Special circumstances */}
              <YesNoField label={ob.special.unaccompaniedLabel} value={form.is_unaccompanied_minor} onChange={(v) => set("is_unaccompanied_minor", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.special.disabledLabel} value={form.is_disabled} onChange={(v) => set("is_disabled", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.special.blindLabel} value={form.is_blind} onChange={(v) => set("is_blind", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.special.workQuartersLabel} value={form.has_40_work_quarters} onChange={(v) => set("has_40_work_quarters", v)} yes={ob.yes} no={ob.no} />

              {/* Goals */}
              <YesNoField label={ob.goals.employmentLabel} value={form.is_employed_or_seeking} onChange={(v) => set("is_employed_or_seeking", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.goals.businessLabel} value={form.wants_to_start_business} onChange={(v) => set("wants_to_start_business", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.goals.englishLabel} value={form.wants_english_classes} onChange={(v) => set("wants_english_classes", v)} yes={ob.yes} no={ob.no} />
              <YesNoField label={ob.goals.interpreterLabel} value={form.needs_interpreter} onChange={(v) => set("needs_interpreter", v)} yes={ob.yes} no={ob.no} />

              {saveError && (
                <div className="rounded-[--radius-md] bg-danger-50 px-4 py-3 text-sm font-medium text-danger-700 ring-1 ring-danger-100">
                  {saveError}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-5 py-3.5 text-base font-semibold text-on-primary shadow-sm transition active:scale-[0.98] hover:bg-primary-hover hover:shadow-md disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none"
                >
                  {saving ? t.dashboard.settings.saving : t.common.save}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setSaveError(""); }}
                  disabled={saving}
                  className="inline-flex items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface px-5 py-3.5 text-base font-semibold text-text-muted transition hover:text-text focus-visible:outline-none disabled:opacity-40"
                >
                  {t.common.cancel}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ── AUTO-FILL ── */}
        <section className="mt-6 rounded-[--radius-md] border border-border bg-surface p-5 shadow-sm md:p-6">
          <h2 className="text-xl font-semibold text-text">{t.dashboard.autofill.title}</h2>
          <AutofillSetup />
        </section>
      </div>
  );

  // Embedded inside the dashboard shell (the Settings tab) — render only the
  // body so the dashboard's own navbar/footer stay in place and Settings no
  // longer feels like a disconnected page. Standalone keeps its own header.
  if (embedded) return body;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-surface px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <span className="flex items-center gap-2 font-display font-semibold text-text">
            <Logo size={26} />
            Wayfinder
          </span>
          <a
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-[--radius-md] px-3 py-2 text-sm font-semibold text-harbor-700 transition hover:bg-harbor-50 focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </span>
            {t.dashboard.settings.backToDashboard}
          </a>
        </div>
      </header>
      {body}
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-semibold text-text-muted">{label}</label>
      {children}
    </div>
  );
}

function YesNoField({
  label, hint, value, onChange, yes, no,
}: {
  label: string;
  hint?: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  yes: string;
  no: string;
}) {
  const base = "flex flex-1 items-center justify-center rounded-[--radius-md] border-2 px-4 py-2.5 text-base font-semibold transition focus-visible:outline-none focus-visible:shadow-focus";
  const on = "border-harbor-500 bg-harbor-50 text-harbor-800";
  const off = "border-border bg-surface-2 text-text hover:border-harbor-300";
  return (
    <div className="rounded-[--radius-md] border border-border bg-surface p-4">
      <p className="mb-1 font-semibold text-text">{label}</p>
      {hint && <p className="mb-3 text-sm text-text-muted">{hint}</p>}
      <div className="flex gap-3">
        <button type="button" aria-pressed={value === true} onClick={() => onChange(true)} className={`${base} ${value === true ? on : off}`}>
          {yes}
        </button>
        <button type="button" aria-pressed={value === false} onClick={() => onChange(false)} className={`${base} ${value === false ? on : off}`}>
          {no}
        </button>
      </div>
    </div>
  );
}
