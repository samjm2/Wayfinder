"use client";

import { useEffect } from "react";
import { useTranslation } from "@/components/i18n/TranslationProvider";

interface Props {
  // Object URL (in-memory blob URL) for the file being previewed.
  url: string;
  fileName: string;
  // True when the file is a PDF; otherwise treated as an image.
  isPdf: boolean;
  onClose: () => void;
}

// Ephemeral, in-memory document preview. Renders images inline and PDFs in an
// <object>/<iframe> from an object URL. Nothing is persisted.
export default function DocumentPreview({ url, fileName, isPdf, onClose }: Props) {
  const { t } = useTranslation();

  // Close on Escape and lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.dashboard.documents.preview}
      className="fixed inset-0 z-50 flex flex-col bg-text/70 p-4 backdrop-blur-sm md:p-8"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-[--radius-lg] border border-border bg-surface shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border bg-surface-2 px-5 py-4">
          <p className="truncate font-display text-lg font-bold text-text" title={fileName}>
            {fileName}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.dashboard.documents.close}
            className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-2 text-sm font-semibold text-text transition hover:bg-surface-2 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            {t.dashboard.documents.close}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surface-2">
          {isPdf ? (
            <object data={url} type="application/pdf" className="h-full w-full">
              <iframe src={url} title={fileName} className="h-full w-full border-0" />
            </object>
          ) : (
            <div className="flex h-full w-full items-center justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={fileName}
                className="max-h-full max-w-full rounded-[--radius-md] object-contain"
              />
            </div>
          )}
        </div>

        <p className="border-t border-border bg-surface px-5 py-3 text-center text-xs text-text-faint">
          {t.dashboard.documents.secureLine}
        </p>
      </div>
    </div>
  );
}
