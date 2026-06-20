"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EligibilityBenefit, Profile, Document } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import { createClient } from "@/lib/supabase/client";
import { putFormFile, type StoredFormFile } from "@/lib/formFileStore";

type FormInfo = {
  how_to_apply?: string;
  apply_link?: string;
  form?: { name?: string; url?: string; type?: string };
};

interface Props {
  language?: string;
  profile?: Profile;
  documents?: Document[];
  benefits?: EligibilityBenefit[];
  formInfoById?: Record<string, FormInfo>;
}

// Fields we NEVER put in the context sent to the assistant. Mirrors the
// extraction route's FORBIDDEN_FIELDS — even if a document somehow has one of
// these in extracted_fields, it must not leave the browser.
const SENSITIVE_FIELD_RE =
  /ssn|social.?security|a.?number|alien.?reg|uscis|passport|bank|account|routing|card/i;

// Income brackets keep the user's exact dollar figure out of the prompt.
function incomeBand(monthly: number | null | undefined): string | null {
  if (monthly == null || Number.isNaN(monthly)) return null;
  if (monthly <= 0) return "no reported income";
  if (monthly < 1500) return "under $1,500/mo";
  if (monthly < 3000) return "$1,500–$3,000/mo";
  if (monthly < 5000) return "$3,000–$5,000/mo";
  return "over $5,000/mo";
}

function yn(v: boolean | null | undefined): string {
  return v == null ? "unknown" : v ? "yes" : "no";
}

// Build a privacy-scrubbed context string: profile summary + non-sensitive
// extracted fields from every uploaded document. Never includes SSN / A-Number /
// passport / bank numbers.
function buildContext(
  profile: Profile | undefined,
  documents: Document[],
): string {
  const lines: string[] = [];

  if (profile) {
    const goals: string[] = [];
    if (profile.is_employed_or_seeking) goals.push("employment");
    if (profile.wants_to_start_business) goals.push("starting a business");
    if (profile.wants_english_classes) goals.push("English classes");
    if (profile.needs_interpreter) goals.push("needs an interpreter");

    const profileLines: Array<[string, string | null | undefined]> = [
      ["immigration status", profile.immigration_status],
      ["ORR eligibility date", profile.eligibility_date],
      ["arrival date", profile.arrival_date],
      ["status grant date", profile.status_grant_date],
      ["age", profile.age != null ? String(profile.age) : null],
      [
        "household size",
        profile.household_size != null ? String(profile.household_size) : null,
      ],
      ["income band", incomeBand(profile.household_gross_monthly_income)],
      ["state", profile.state],
      ["city", profile.city],
      ["has SSN", yn(profile.has_ssn)],
      ["has work permit (EAD)", yn(profile.has_ead)],
      ["has I-94", yn(profile.has_i94)],
      ["pregnant", yn(profile.is_pregnant)],
      ["disabled", yn(profile.is_disabled)],
      ["goals", goals.length ? goals.join(", ") : null],
    ];

    lines.push("Profile:");
    for (const [label, value] of profileLines) {
      if (value != null && value !== "" && value !== "unknown") {
        lines.push(`- ${label}: ${value}`);
      }
    }
  }

  const docFacts: string[] = [];
  for (const doc of documents) {
    const fields = doc.extracted_fields;
    if (!fields) continue;
    for (const [key, value] of Object.entries(fields)) {
      if (!value) continue;
      if (SENSITIVE_FIELD_RE.test(key)) continue; // never include sensitive fields
      docFacts.push(`- ${key}: ${value}`);
    }
  }
  if (docFacts.length) {
    lines.push("");
    lines.push("From the user's uploaded documents:");
    lines.push(...docFacts);
  }

  return lines.join("\n").trim();
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface UploadedFile {
  name: string;
  type: string;
  isPdf: boolean;
  stored: StoredFormFile;
  isLegal: boolean;
}

const LEGAL_FILE_RE =
  /i-?[0-9]{3,}|i-?485|i-?589|i-?130|i-?751|eoir|asylum|removal|deportation|uscis|ead|advance.?parole/i;

function detectLegal(name: string): boolean {
  return LEGAL_FILE_RE.test(name);
}

// Reused from ActionPlan
const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide";

function Dot({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 8 8" className={`h-2 w-2 ${className}`}>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

function deadlineBadge(
  deadline: EligibilityBenefit["deadline"],
): { text: string; tone: string } | null {
  if (!deadline.deadlineDate && !deadline.label) return null;
  if (deadline.deadlineDate) {
    const target = new Date(deadline.deadlineDate);
    if (!Number.isNaN(target.getTime())) {
      const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
      if (days <= 0) {
        return { text: "Window may have passed", tone: "bg-sand-100 text-sand-600" };
      }
      const tone =
        days < 7
          ? "bg-danger-50 text-danger-700 animate-[pulse_2s_ease-in-out_infinite]"
          : days < 30
          ? "bg-review-50 text-review-700"
          : "bg-harbor-50 text-harbor-700";
      return {
        text: days === 1 ? "1 day left to apply" : `${days} days left to apply`,
        tone,
      };
    }
  }
  return { text: deadline.label, tone: "bg-harbor-50 text-harbor-700" };
}

export default function FormAssistant({
  language,
  profile,
  documents = [],
  benefits = [],
  formInfoById,
}: Props) {
  const { t, lang } = useTranslation();
  const fh = t.dashboard.formHelper;
  const router = useRouter();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Chat assistant state ──────────────────────────────────────────────────
  const [docs, setDocs] = useState<Document[]>(documents);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // If documents weren't passed as a prop, fetch the user's extracted_fields
  // directly via the browser supabase client so the assistant can use them.
  useEffect(() => {
    if (documents.length > 0) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("documents")
        .select("id, user_id, file_name, file_path, file_size, mime_type, document_type, extracted_fields, uploaded_at")
        .eq("user_id", user.id);
      if (!cancelled && data) setDocs(data as Document[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [documents.length]);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;

    setChatError(null);
    setAsking(true);
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setQuestion("");

    const context = buildContext(profile, docs);

    try {
      const res = await fetch("/api/form-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          language: language ?? lang ?? "en",
          context,
        }),
      });
      const data = (await res.json()) as { answer?: string; error?: string };
      if (!res.ok || !data.answer) {
        setChatError(data.error ?? fh.thinking);
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", text: data.answer! }]);
    } catch {
      setChatError(fh.thinking);
    } finally {
      setAsking(false);
    }
  }

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;
    const next: UploadedFile[] = [];
    for (const file of Array.from(selected)) {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const stored = putFormFile(file);
      next.push({ name: file.name, type: file.type, isPdf, stored, isLegal: detectLegal(file.name) });
    }
    setFiles((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.stored.id !== id));
  }

  function handleFillBenefit(benefitId: string, formName?: string) {
    const params = new URLSearchParams({ benefit: benefitId, mode: "fill" });
    if (formName) params.set("form", formName);
    router.push(`/form?${params.toString()}`);
  }

  const eligibleBenefits = benefits.filter((b) => b.status === "likely_eligible");

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h2 className="font-display text-2xl font-bold text-text md:text-3xl">
          Apply for Benefits
        </h2>
        <p className="mt-1 text-lg text-text-muted">
          Select a benefit below and we&apos;ll pre-fill your application using the information you
          already gave us. You review everything before submitting.
        </p>
        <div className="mt-3 inline-flex items-start gap-2 rounded-[--radius-md] bg-success-50 px-4 py-2 text-sm font-medium text-success-700 ring-1 ring-success-100">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-shrink-0" fill="currentColor">
            <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V8H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 7V5.5a3 3 0 1 0-6 0V8h6Z" clipRule="evenodd" />
          </svg>
          <span>
            Sensitive fields (SSN, A-number, bank details) are <strong>never</strong> pre-filled.
            You enter those directly on the official site.
          </span>
        </div>
      </div>

      {/* ── Section 0: Ask the Form Assistant ── */}
      <section>
        <h3 className="mb-1 font-display text-lg font-bold text-text">{fh.title}</h3>
        <p className="mb-3 text-sm text-text-muted">{fh.subtitle}</p>

        {/* Tell the user their saved info is being used to answer for them. */}
        <div className="mb-4 inline-flex items-start gap-2 rounded-[--radius-md] bg-harbor-50 px-4 py-2 text-sm font-medium text-harbor-700 ring-1 ring-harbor-100">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-shrink-0" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a1 1 0 0 0 0 2v3a1 1 0 0 0 1 1h1a1 1 0 1 0 0-2v-3a1 1 0 0 0-1-1H9Z" clipRule="evenodd" />
          </svg>
          <span>{fh.contextNote}</span>
        </div>

        {messages.length > 0 && (
          <ul className="mb-4 flex flex-col gap-3">
            {messages.map((m, i) => (
              <li
                key={i}
                className={
                  m.role === "user"
                    ? "ml-auto max-w-[85%] rounded-[--radius-lg] bg-primary px-4 py-3 text-sm text-on-primary"
                    : "mr-auto max-w-[90%] whitespace-pre-wrap rounded-[--radius-lg] border border-border bg-surface px-4 py-3 text-sm text-text"
                }
              >
                {m.text}
              </li>
            ))}
            {asking && (
              <li className="mr-auto rounded-[--radius-lg] border border-border bg-surface px-4 py-3 text-sm text-text-muted">
                {fh.thinking}
              </li>
            )}
          </ul>
        )}

        <form onSubmit={handleAsk} className="flex flex-col gap-2">
          <label htmlFor="form-assist-input" className="text-sm font-medium text-text">
            {fh.pasteInstructions}
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="form-assist-input"
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={fh.placeholder}
              disabled={asking}
              className="min-h-[48px] flex-1 rounded-[--radius-md] border border-border bg-surface px-4 py-3 text-base text-text placeholder:text-text-faint focus-visible:border-harbor-400 focus-visible:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={asking || !question.trim()}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-3 text-base font-bold text-on-primary shadow-sm transition hover:bg-primary-hover active:scale-[0.98] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {asking ? fh.thinking : fh.send}
            </button>
          </div>
        </form>

        {chatError && (
          <p className="mt-2 text-sm font-medium text-danger-700">{chatError}</p>
        )}

        <p className="mt-3 text-xs text-text-faint">{fh.sensitiveNote}</p>
      </section>

      {/* ── Section 1: Eligible benefits ── */}
      <section>
        <h3 className="mb-4 font-display text-lg font-bold text-text">Your eligible programs</h3>

        {eligibleBenefits.length === 0 ? (
          <div className="rounded-[--radius-lg] border border-border bg-surface p-8 text-center">
            <p className="text-text-muted">
              No eligible programs found yet.{" "}
              <Link href="/processing" className="font-semibold text-primary underline-offset-2 hover:underline">
                Run eligibility check
              </Link>{" "}
              or{" "}
              <button
                type="button"
                className="font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none"
                onClick={() => fileInputRef.current?.click()}
              >
                upload your own form below
              </button>
              .
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {eligibleBenefits.map((benefit) => {
              const info = formInfoById?.[benefit.id];
              const formName = info?.form?.name;
              const formUrl = info?.form?.url ?? benefit.applicationLink;
              const dl = deadlineBadge(benefit.deadline);
              const isAttorney = benefit.needsAttorney;

              return (
                <div
                  key={benefit.id}
                  className={`overflow-hidden rounded-[--radius-lg] border bg-surface shadow-sm transition-shadow hover:shadow-md ${
                    isAttorney ? "border-review-100 bg-review-50/30" : "border-border"
                  }`}
                >
                  <div className="p-5 md:p-6">
                    {/* Status + deadline row */}
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className={`${BADGE_BASE} bg-success-50 text-success-700 ring-1 ring-success-100`}>
                        <Dot className="text-current" />
                        Eligible
                      </span>
                      {isAttorney && (
                        <span className={`${BADGE_BASE} bg-review-50 text-review-700 ring-1 ring-review-100`}>
                          Attorney recommended
                        </span>
                      )}
                      {dl && (
                        <span className={`${BADGE_BASE} ${dl.tone}`}>{dl.text}</span>
                      )}
                    </div>

                    <h4 className="mb-1 font-display text-xl font-bold text-text">{benefit.name}</h4>
                    <p className="mb-4 text-sm text-text-muted">{benefit.whyPlainLanguage}</p>

                    {/* Attorney banner */}
                    {isAttorney && (
                      <div className="mb-4 rounded-[--radius-md] border border-review-100 bg-review-50 px-4 py-3 text-sm font-semibold text-review-700">
                        This is a legal matter. Work with a licensed attorney or DOJ-accredited
                        representative before filing any application.
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex flex-wrap gap-3">
                      {isAttorney ? (
                        <span className="inline-flex min-h-[48px] cursor-not-allowed items-center justify-center gap-2 rounded-[--radius-md] bg-sand-100 px-6 py-3 text-base font-semibold text-sand-500 opacity-70">
                          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                            <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V8H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 7V5.5a3 3 0 1 0-6 0V8h6Z" clipRule="evenodd" />
                          </svg>
                          See an attorney before filing
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleFillBenefit(benefit.id, formName)}
                          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-3 text-base font-bold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none"
                        >
                          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                            <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
                          </svg>
                          Fill Out with AI
                        </button>
                      )}
                      {formUrl && (
                        <a
                          href={formUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-5 py-3 text-base font-semibold text-harbor-700 transition hover:border-harbor-500 hover:bg-harbor-50 active:scale-[0.98] focus-visible:outline-none"
                        >
                          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
                            <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
                          </svg>
                          View official form
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Section 2: Upload your own form ── */}
      <section>
        <div className="mb-4 border-t border-border pt-6">
          <h3 className="mb-1 font-display text-lg font-bold text-text">Upload your own form</h3>
          <p className="mb-4 text-sm text-text-muted">
            Have a government form you want help filling out? Upload it here and we&apos;ll pre-fill
            the fields we can from your profile.
          </p>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-[--radius-md] border-2 border-dashed border-border bg-surface-2 px-5 py-4 text-base font-semibold text-text-muted transition hover:border-harbor-400 hover:bg-harbor-50 hover:text-text focus-visible:outline-none"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
              <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
            </svg>
            Choose file (PDF or image)
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            onChange={handleFilesSelected}
            className="sr-only"
            aria-label="Upload a form"
          />
        </div>

        {files.length > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-faint">
              Your files are processed in your browser and never shared with immigration enforcement.
            </p>
            <ul className="flex flex-col gap-3">
              {files.map((file) => (
                <li
                  key={file.stored.id}
                  className="overflow-hidden rounded-[--radius-lg] border border-border bg-surface shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3 p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[--radius-md] bg-harbor-50 text-harbor-600">
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
                          <path d="M5 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.414A2 2 0 0 0 16.414 6L13 2.586A2 2 0 0 0 11.586 2H5Z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-text">{file.name}</p>
                        <p className="text-xs text-text-faint">{file.isPdf ? "PDF" : "Image"}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {file.isPdf && (
                        <Link
                          href={`/form?src=${encodeURIComponent(file.stored.id)}&mode=fill`}
                          className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-[--radius-md] bg-primary px-4 py-2 text-sm font-bold text-on-primary shadow-sm transition hover:bg-primary-hover active:scale-[0.98] focus-visible:outline-none"
                        >
                          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
                          </svg>
                          Fill with AI
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFile(file.stored.id)}
                        aria-label={`Remove ${file.name}`}
                        title="Remove"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-[--radius-md] text-text-faint transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
                      >
                        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {/* Legal heuristic warning */}
                  {file.isLegal && (
                    <div className="border-t border-review-100 bg-review-50 px-4 py-3 text-sm font-semibold text-review-700">
                      This looks like an immigration form. A licensed attorney or DOJ-accredited
                      representative should review it before you submit.
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
