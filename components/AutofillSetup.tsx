"use client";

// Shared Auto-fill setup UI used in two places:
//  1) Settings (the renamed "Browser Extension" card)
//  2) The optional Auto-fill step near the end of onboarding
//
// It calls POST /api/extension/pair to mint a short-lived pairing code and shows
// it. Errors are handled gracefully: a 503 (missing pairing table OR missing
// EXTENSION_JWT_SECRET) shows a friendly "not available yet" message instead of
// a raw error, and the rest fall back to a generic retry message.

import { useState } from "react";
import { useTranslation } from "@/components/i18n/TranslationProvider";

export default function AutofillSetup() {
  const { t } = useTranslation();
  const af = t.dashboard.autofill;

  const [code, setCode] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSetUp() {
    setLoading(true);
    setError("");
    setCode(null);
    try {
      const res = await fetch("/api/extension/pair", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        code?: string;
        expiresAt?: string;
        error?: string;
        unavailable?: boolean;
      };
      if (res.status === 503 || data.unavailable) {
        setError(af.unavailable);
      } else if (!res.ok || !data.code) {
        setError(af.genericError);
      } else {
        setCode(data.code);
        setExpiry(data.expiresAt ?? null);
      }
    } catch {
      setError(af.networkError);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="mt-1 text-base text-text-muted">{af.intro}</p>

      {/* The extension isn't on the Chrome Web Store yet, so judges load it
          unpacked from the bundled .zip. This note + download button + the
          load-unpacked steps below make that flow self-serve. */}
      <div className="mt-4 rounded-[--radius-md] border border-caution-100 bg-caution-50 px-4 py-3 text-sm text-caution-700">
        {af.judgeNote}
      </div>

      <a
        href="/wayfinder-extension.zip"
        download
        className="mt-4 inline-flex items-center gap-2 rounded-[--radius-md] bg-harbor-600 px-5 py-3 text-base font-semibold text-white transition active:scale-[0.98] hover:bg-harbor-700 focus-visible:outline-none focus-visible:shadow-focus"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
        {af.downloadExtension}
      </a>

      {/* One-time setup steps — shown so a first-time user (or a judge demoing)
          knows exactly how to install the extension and fill a form. */}
      <ol className="mt-4 space-y-2 rounded-[--radius-md] border border-border bg-canvas/60 p-4">
        <li className="text-sm font-semibold text-text">{af.howToTitle}</li>
        {[af.howToStep1, af.howToStep2, af.howToStep3, af.howToStep4, af.howToStep5, af.howToStep6].map((step, i) => (
          <li key={i} className="flex gap-3 text-sm text-text-muted">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-harbor-100 text-xs font-bold text-harbor-700">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex items-start gap-2 rounded-[--radius-md] bg-harbor-50 px-4 py-3 text-sm text-harbor-800 ring-1 ring-harbor-100">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 flex-shrink-0"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>{af.privacy}</span>
      </div>

      {error && (
        <div className="mt-4 rounded-[--radius-md] bg-caution-50 px-4 py-3 text-sm font-medium text-caution-700 ring-1 ring-caution-100">
          {error}
        </div>
      )}

      {code ? (
        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-text-muted">{af.codeInstructions}</p>
          <div className="rounded-[--radius-md] border-2 border-harbor-300 bg-harbor-50 px-6 py-4 text-center">
            <p className="font-mono text-3xl font-bold tracking-[6px] text-harbor-800">{code}</p>
            <p className="mt-2 text-xs text-text-faint">
              {af.expiresIn}{" "}
              {expiry && af.expiresAt.replace("{time}", new Date(expiry).toLocaleTimeString())}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSetUp}
            disabled={loading}
            className="mt-3 text-sm font-semibold text-text-muted underline-offset-2 hover:underline focus-visible:outline-none disabled:opacity-40"
          >
            {af.newCode}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleSetUp}
          disabled={loading}
          className="mt-4 inline-flex items-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-5 py-3 text-base font-semibold text-harbor-700 transition active:scale-[0.98] hover:border-harbor-500 hover:bg-harbor-50 disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-focus"
        >
          {loading ? af.generating : af.setUp}
        </button>
      )}
    </div>
  );
}
