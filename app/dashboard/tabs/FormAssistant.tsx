"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Profile, Document, EligibilityBenefit } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import { putFormFile, type StoredFormFile } from "@/lib/formFileStore";

type FormInfo = {
  how_to_apply?: string;
  apply_link?: string;
  form?: { name?: string; url?: string; type?: string };
};

interface Props {
  language: string;
  profile?: Profile;
  documents?: Document[];
  benefits?: EligibilityBenefit[];
  formInfoById?: Record<string, FormInfo>;
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
  profile: _profile,
  documents: _documents,
  benefits = [],
  formInfoById,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          Select a benefit below and we'll pre-fill your application using the information you
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
            Have a government form you want help filling out? Upload it here and we'll pre-fill
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
