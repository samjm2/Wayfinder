"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { EligibilityBenefit, BenefitProgress, ProgressStatus } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";

interface Props {
  benefits: EligibilityBenefit[];
  progressRows: BenefitProgress[];
  userId: string;
}

// Status visuals: a simple colored dot replaces the previous emoji icons.
const STATUS_META: { value: ProgressStatus; color: string }[] = [
  { value: "not_started", color: "text-text-faint" },
  { value: "in_progress", color: "text-harbor-600" },
  { value: "documents_ready", color: "text-caution-700" },
  { value: "submitted", color: "text-harbor-700" },
  { value: "needs_attorney", color: "text-review-700" },
  { value: "done", color: "text-success-700" },
];

function StatusDot({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 8 8" className={`inline-block h-2 w-2 shrink-0 ${className ?? ""}`}>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

export default function ProgressTracker({ benefits, progressRows, userId }: Props) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<Record<string, ProgressStatus>>(
    Object.fromEntries(progressRows.map((r) => [r.benefit_id, r.status]))
  );
  const [saving, setSaving] = useState<string | null>(null);

  const statuses = STATUS_META.map((s) => ({
    ...s,
    label: t.dashboard.progress.statuses[s.value],
  }));

  async function updateStatus(benefitId: string, benefitName: string, status: ProgressStatus) {
    setSaving(benefitId);
    const supabase = createClient();

    await supabase.from("benefit_progress").upsert(
      {
        user_id: userId,
        benefit_id: benefitId,
        benefit_name: benefitName,
        status,
      },
      { onConflict: "user_id,benefit_id" }
    );

    setProgress((p) => ({ ...p, [benefitId]: status }));
    setSaving(null);
  }

  if (benefits.length === 0) {
    return (
      <div className="rounded-[--radius-lg] border border-border bg-surface p-8 text-center md:p-12">
        <div
          aria-hidden="true"
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-harbor-50 text-harbor-500"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8">
            <path d="M3 3v18h18" />
            <rect x="7" y="10" width="3" height="7" />
            <rect x="14" y="6" width="3" height="11" />
          </svg>
        </div>
        <h2 className="font-display text-xl font-bold text-text">{t.dashboard.progress.title}</h2>
        <p className="mx-auto mt-2 max-w-md text-text-muted">{t.dashboard.progress.subtitle}</p>
      </div>
    );
  }

  const doneCount = benefits.filter((b) => (progress[b.id] ?? "not_started") === "done").length;
  const total = benefits.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div>
      <h2 className="mb-2 font-display text-2xl font-bold text-text md:text-3xl">
        {t.dashboard.progress.title}
      </h2>
      <p className="mb-6 text-lg text-text-muted">{t.dashboard.progress.subtitle}</p>

      {/* Summary card */}
      <div className="mb-6 rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm md:p-6">
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <span className="text-xs font-bold uppercase tracking-wider text-text-muted">
            {t.dashboard.progress.title}
          </span>
          <span className="font-display text-lg font-bold text-text">
            {doneCount} / {total}
          </span>
        </div>
        <div
          className="h-2.5 w-full overflow-hidden rounded-full bg-sand-200"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t.dashboard.progress.title}
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {benefits.map((benefit) => {
          const currentStatus = progress[benefit.id] ?? "not_started";
          const currentStatusInfo = statuses.find((s) => s.value === currentStatus);

          return (
            <div
              key={benefit.id}
              className="rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm transition-shadow hover:shadow-md md:p-6"
            >
              <div className="mb-4 flex items-start justify-between gap-4">
                <h3 className="font-display text-xl font-bold text-text">{benefit.name}</h3>
                <span className={`flex shrink-0 items-center gap-1.5 text-sm font-semibold ${currentStatusInfo?.color}`}>
                  <StatusDot /> {currentStatusInfo?.label}
                </span>
              </div>

              <div role="group" aria-label={`${t.dashboard.progress.updateStatus}: ${benefit.name}`} className="flex flex-wrap gap-2">
                {statuses.map((s) => {
                  const selected = currentStatus === s.value;
                  return (
                    <button
                      key={s.value}
                      onClick={() => updateStatus(benefit.id, benefit.name, s.value)}
                      disabled={saving === benefit.id}
                      aria-pressed={selected}
                      className={`flex items-center gap-2 rounded-[--radius-md] border-2 px-3 py-2 text-sm font-semibold transition active:scale-[0.98] focus-visible:outline-none disabled:opacity-50 ${
                        selected
                          ? "border-harbor-500 bg-harbor-50 text-harbor-800"
                          : "border-border bg-surface text-text hover:border-harbor-300"
                      }`}
                    >
                      <StatusDot className={s.color} /> {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
