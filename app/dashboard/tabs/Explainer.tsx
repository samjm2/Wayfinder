"use client";

import { useState } from "react";
import { useTranslation } from "@/components/i18n/TranslationProvider";

interface Props {
  language: string;
}

export default function Explainer({ language }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);

  function statusFallback(status: number): string {
    if (status === 429) return t.errors.generic;
    if (status >= 500) return t.errors.generic;
    if (status === 400) return t.errors.generic;
    return t.errors.generic;
  }

  async function handleExplain() {
    if (!text.trim() || loading) return;
    setLoading(true);
    setResult("");
    setIsError(false);

    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), language }),
      });

      // Parse defensively — the body may be non-JSON (e.g. an HTML error page).
      let data: { explanation?: string; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok || !data?.explanation) {
        setResult(data?.error ?? statusFallback(res.status));
        setIsError(true);
      } else {
        setResult(data.explanation);
        setIsError(false);
      }
    } catch {
      setResult(t.errors.generic);
      setIsError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="font-display text-2xl font-bold text-text md:text-3xl">
        {t.dashboard.explainer.title}
      </h2>
      <p className="mt-1 mb-8 text-lg text-text-muted">
        {t.dashboard.explainer.subtitle}
      </p>

      <div className="mb-4">
        <label htmlFor="explainer-input" className="mb-1.5 block text-sm font-semibold text-text-muted">
          {t.dashboard.explainer.pasteLabel}
        </label>
        <textarea
          id="explainer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.dashboard.explainer.placeholder}
          rows={8}
          className="min-h-32 w-full resize-none rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
        />
      </div>

      <button
        type="button"
        onClick={handleExplain}
        disabled={loading || !text.trim()}
        className="mb-8 inline-flex w-full items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
      >
        {loading ? t.dashboard.explainer.thinking : t.dashboard.explainer.explain}
      </button>

      <div aria-live="polite" aria-busy={loading}>
        {result &&
          (isError ? (
            <div
              role="alert"
              className="rounded-[--radius-md] bg-danger-50 px-4 py-3 text-base font-medium text-danger-700 ring-1 ring-danger-100"
            >
              {result}
            </div>
          ) : (
            <div className="rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm md:p-6">
              <h3 className="mb-4 font-display text-xl font-bold text-text">
                {t.dashboard.explainer.title}
              </h3>
              <div className="whitespace-pre-wrap text-base text-text">{result}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
