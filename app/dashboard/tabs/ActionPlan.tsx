"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EligibilityBenefit } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";

// Presentation-only form info, threaded from benefits.json by the shell task.
type FormInfo = {
  how_to_apply?: string;
  apply_link?: string;
  form?: { name?: string; url?: string; type?: string };
};

interface Props {
  benefits: EligibilityBenefit[];
  attorneyNeeded: boolean;
  rulesLastChecked: string;
  onSwitchTab: (tab: "plan" | "documents" | "form" | "help" | "progress") => void;
  formInfoById?: Record<string, FormInfo>;
}

const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide";

// Small inline SVG dot used in place of the old status emoji glyphs.
function Dot({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 8 8" className={`h-2 w-2 ${className}`}>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

const STATUS_TONE: Record<string, string> = {
  likely_eligible: `${BADGE_BASE} bg-success-50 text-success-700 ring-1 ring-success-100`,
  not_eligible: `${BADGE_BASE} bg-sand-100 text-sand-600 ring-1 ring-sand-200`,
};

// Live deadline computation — recomputed on every render so the countdown is
// correct each day. Never returns a negative number.
function deadlineInfo(
  deadline: EligibilityBenefit["deadline"],
  t: ReturnType<typeof useTranslation>["t"],
): { text: string; urgent: boolean; critical: boolean; passed: boolean } | null {
  if (deadline.deadlineDate) {
    const target = new Date(deadline.deadlineDate);
    if (!Number.isNaN(target.getTime())) {
      const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
      if (days <= 0) {
        return {
          text: t.dashboard.actionPlan.deadlinePassedClear,
          urgent: false,
          critical: false,
          passed: true,
        };
      }
      const text =
        days === 1
          ? t.dashboard.actionPlan.oneDayLeftToApply
          : t.dashboard.actionPlan.daysLeftToApply.replace("{days}", String(days));
      return { text, urgent: days < 30, critical: days < 7, passed: false };
    }
  }
  if (deadline.label) {
    return { text: deadline.label, urgent: false, critical: false, passed: false };
  }
  return { text: t.dashboard.actionPlan.noDeadline, urgent: false, critical: false, passed: false };
}

export default function ActionPlan({
  benefits,
  attorneyNeeded,
  rulesLastChecked,
  onSwitchTab,
  formInfoById,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);

  const ap = t.dashboard.actionPlan;

  function statusLabel(status: string): string {
    const badges = ap.statusBadges as Record<string, string>;
    return badges[status] ?? badges.not_eligible;
  }

  function statusTone(status: string): string {
    return STATUS_TONE[status] ?? STATUS_TONE.not_eligible;
  }

  // Navigate to the dedicated form page so the right form opens; if that route
  // is not present, fall back to the in-dashboard Form Assistant tab.
  function handleFormHelp(benefitId: string, formName?: string) {
    try {
      const params = new URLSearchParams({ benefit: benefitId });
      if (formName) params.set("form", formName);
      router.push(`/form?${params.toString()}`);
    } catch {
      onSwitchTab("form");
    }
  }

  if (benefits.length === 0) {
    return (
      <div className="rounded-[--radius-lg] border border-border bg-surface p-8 text-center md:p-12">
        <div
          aria-hidden="true"
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-harbor-50 text-harbor-600"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <h2 className="font-display text-xl font-bold text-text">{ap.noResults}</h2>
        <button
          onClick={() => onSwitchTab("help")}
          className="mt-6 inline-flex w-auto items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none"
        >
          {t.dashboard.tabs.findHelp}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold text-text md:text-3xl">{ap.title}</h2>
          <p className="mt-1 text-lg text-text-muted">{ap.subtitle}</p>
        </div>
        {rulesLastChecked && (
          <p className="shrink-0 text-xs text-text-faint">
            {ap.rulesChecked} {rulesLastChecked}
          </p>
        )}
      </div>

      {attorneyNeeded && (
        <div className="mb-6 rounded-[--radius-md] border border-review-100 bg-review-50 px-5 py-4 text-sm font-semibold text-review-700">
          {ap.attorney}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {benefits.map((benefit) => {
          const isOpen = expanded === benefit.id;
          const info = formInfoById?.[benefit.id];
          const formName = info?.form?.name;
          const applyLink = info?.apply_link || benefit.applicationLink;
          const dl = deadlineInfo(benefit.deadline, t);
          const dlTone = dl?.passed
            ? "bg-sand-100 text-sand-600"
            : dl?.critical
            ? "bg-danger-50 text-danger-700 animate-[pulse_2s_ease-in-out_infinite]"
            : dl?.urgent
            ? "bg-review-50 text-review-700"
            : "bg-harbor-50 text-harbor-700";

          return (
            <div
              key={benefit.id}
              className="overflow-hidden rounded-[--radius-lg] border border-border bg-surface shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="p-5 md:p-6">
                <div className="mb-3 flex flex-wrap items-start gap-2">
                  <span className={statusTone(benefit.status)}>
                    <Dot className="text-current" />
                    {statusLabel(benefit.status)}
                  </span>
                  {benefit.needsAttorney && (
                    <span className={`${BADGE_BASE} bg-harbor-50 text-harbor-700 ring-1 ring-harbor-100`}>
                      {ap.attorney}
                    </span>
                  )}
                </div>

                <h3 className="mb-2 font-display text-xl font-bold text-text">{benefit.name}</h3>
                <p className="mb-4 text-text">{benefit.whyPlainLanguage}</p>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  {dl && <span className={`${BADGE_BASE} ${dlTone}`}>{dl.text}</span>}
                  <div className="flex flex-wrap gap-3">
                    {benefit.sources[0]?.url && (
                      <a
                        href={benefit.sources[0].url}
                        target="_blank"
                        rel="noopener noreferrer"
                        role="button"
                        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-4 py-2.5 text-sm font-semibold text-harbor-700 transition hover:border-harbor-500 hover:bg-harbor-50 active:scale-[0.98] focus-visible:outline-none"
                      >
                        {ap.sourceLink}
                      </a>
                    )}
                    <button
                      onClick={() => setExpanded(isOpen ? null : benefit.id)}
                      aria-expanded={isOpen}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none"
                    >
                      {isOpen ? t.common.close : ap.details}
                    </button>
                  </div>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-border bg-surface-2 p-5 md:p-6">
                  {benefit.needsAttorney && (
                    <div className="mb-4 rounded-[--radius-md] border border-review-100 bg-review-50 px-5 py-4 text-sm font-semibold text-review-700">
                      {ap.attorney}{" "}
                      <button
                        onClick={() => onSwitchTab("help")}
                        className="font-bold underline underline-offset-2 focus-visible:outline-none"
                      >
                        {t.dashboard.tabs.findHelp}
                      </button>
                    </div>
                  )}

                  {/* (1) What you need: required documents + the needed form name */}
                  {(benefit.requiredDocuments.length > 0 || formName) && (
                    <div className="mb-4">
                      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                        {ap.whatYouNeed}
                      </h4>
                      {benefit.requiredDocuments.length > 0 && (
                        <>
                          <p className="mb-1.5 text-xs font-semibold text-text-muted">
                            {ap.requiredDocuments}
                          </p>
                          <ul className="mb-3 flex flex-col gap-1.5">
                            {benefit.requiredDocuments.map((doc, i) => (
                              <li key={i} className="flex gap-2 text-sm text-text">
                                <Dot className="mt-2 text-harbor-400" />
                                <span>{doc}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {formName && (
                        <p className="text-sm text-text">
                          <span className="font-semibold text-text-muted">{ap.formNeeded}: </span>
                          {formName}
                        </p>
                      )}
                    </div>
                  )}

                  {/* (2) Where and how to apply: how_to_apply + apply link */}
                  {(info?.how_to_apply || applyLink) && (
                    <div className="mb-4">
                      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                        {ap.whereHowToApply}
                      </h4>
                      {info?.how_to_apply && (
                        <p className="mb-3 text-sm text-text">{info.how_to_apply}</p>
                      )}
                      {applyLink && (
                        <a
                          href={applyLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          role="button"
                          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] bg-success-600 px-5 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-success-700 active:scale-[0.98] focus-visible:outline-none"
                        >
                          {ap.applyOnline}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Next steps */}
                  {benefit.nextSteps.length > 0 && (
                    <div className="mb-4">
                      <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                        {ap.nextSteps}
                      </h4>
                      <ol className="flex flex-col gap-2.5">
                        {benefit.nextSteps.map((step, i) => (
                          <li key={i} className="flex items-start gap-3 text-sm text-text">
                            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-clay-100 text-xs font-bold text-clay-700">
                              {i + 1}
                            </span>
                            <span className="pt-0.5">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => handleFormHelp(benefit.id, formName)}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-5 py-3.5 text-base font-semibold text-harbor-700 transition hover:border-harbor-500 hover:bg-harbor-50 active:scale-[0.98] focus-visible:outline-none"
                    >
                      {ap.getFormHelp}
                    </button>
                  </div>

                  <p className="mt-4 text-xs text-text-faint">
                    {benefit.administeringAgency}
                    {benefit.sources[0] && (
                      <>
                        {" · "}
                        <a
                          href={benefit.sources[0].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none"
                        >
                          {ap.sourceLink}
                        </a>
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
