"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { Profile, Document } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import { putFormFile, type StoredFormFile } from "@/lib/formFileStore";

interface Props {
  language: string;
  // Threaded by the navbar/shell so the chatbot can answer for THIS user.
  profile?: Profile;
  documents?: Document[];
}

interface Message {
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
}

interface UploadedFile {
  // Local-only handle. Files are held in memory; never persisted server-side.
  name: string;
  type: string;
  isPdf: boolean;
  stored: StoredFormFile;
}

// Static fallback prompt suggestions. These are intentionally English source
// strings; the live UI chrome around them is translated.
const SUGGESTIONS = [
  "Help me fill out Form I-765 for a work permit",
  "What documents do I need for a Medicaid application?",
  "Explain Form I-485 — what is it for?",
  "Help me understand a SNAP application",
];

function statusFallback(status: number): string {
  if (status === 429) return "Too many requests, please wait a moment and try again.";
  if (status >= 500) return "The assistant is temporarily unavailable. Please try again.";
  if (status === 400) return "We could not understand that request. Please try rephrasing.";
  return "Something went wrong. Please try again.";
}

// Build a compact, privacy-scrubbed profile summary. Sensitive NUMBERS (SSN,
// A-Number, passport, bank) are never included — only boolean "has X on file"
// flags and non-sensitive demographics. The server scrubs again as a backstop.
function buildProfileContext(profile?: Profile) {
  if (!profile) return undefined;
  return {
    immigrationStatus: profile.immigration_status,
    state: profile.state,
    city: profile.city,
    householdSize: profile.household_size,
    age: profile.age,
    numChildrenUnder18: profile.num_children_under_18,
    isPregnant: profile.is_pregnant,
    isEmployedOrSeeking: profile.is_employed_or_seeking,
    hasEad: profile.has_ead,
    hasSsn: profile.has_ssn,
    hasI94: profile.has_i94,
    eligibilityDate: profile.eligibility_date,
    arrivalDate: profile.arrival_date,
    statusGrantDate: profile.status_grant_date,
  };
}

// Document FIELD NAMES only — never the values (which may be sensitive).
function buildDocumentFields(documents?: Document[]): string[] {
  if (!documents || documents.length === 0) return [];
  const names = new Set<string>();
  for (const doc of documents) {
    if (doc.extracted_fields) {
      for (const key of Object.keys(doc.extracted_fields)) names.add(key);
    }
  }
  return Array.from(names);
}

export default function FormAssistant({ language, profile, documents }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;
    const next: UploadedFile[] = [];
    for (const file of Array.from(selected)) {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      // Held in memory only via an object URL — never uploaded to a server.
      const stored = putFormFile(file);
      next.push({ name: file.name, type: file.type, isPdf, stored });
    }
    setFiles((prev) => [...prev, ...next]);
    // Allow re-selecting the same file later.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.stored.id !== id));
  }

  async function submitQuery(text: string) {
    const userMessage = text.trim();
    if (!userMessage || loading) return;

    setQuery("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const res = await fetch("/api/form-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: userMessage,
          language,
          profile: buildProfileContext(profile),
          documentFields: buildDocumentFields(documents),
        }),
      });

      // Parse defensively — the body may be non-JSON (e.g. an HTML error page).
      let data: { response?: string; error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok || !data?.response) {
        const message = data?.error ?? statusFallback(res.status);
        setMessages((prev) => [...prev, { role: "assistant", content: message, isError: true }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data!.response! }]);
      }
    } catch {
      // Network-level failure — distinct from a server-returned error.
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "We could not reach the assistant. Please check your connection and try again.",
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submitQuery(query);
  }

  const pdfFiles = files.filter((f) => f.isPdf);

  return (
    <div>
      <h2 className="font-display text-2xl font-bold text-text md:text-3xl">
        {t.dashboard.formHelper.title}
      </h2>
      <p className="mt-1 text-lg text-text-muted">{t.dashboard.formHelper.subtitle}</p>

      <div className="mt-4 inline-flex items-start gap-2 rounded-[--radius-md] bg-success-50 px-4 py-2 text-sm font-medium text-success-700 ring-1 ring-success-100">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="mt-0.5 h-4 w-4 flex-shrink-0"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 1a4.5 4.5 0 0 0-4.5 4.5V8H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 7V5.5a3 3 0 1 0-6 0V8h6Z"
            clipRule="evenodd"
          />
        </svg>
        <span>{t.dashboard.formHelper.sensitiveNote}</span>
      </div>

      <p className="mt-3 text-sm text-text-faint">{t.dashboard.formHelper.contextNote}</p>

      {/* ── OPTIONS / SUGGESTIONS (on top) ─────────────────────────────── */}
      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          {/* Upload files — held in memory only */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none focus-visible:shadow-focus"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
              <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
            </svg>
            {t.dashboard.formHelper.uploadFiles}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            onChange={handleFilesSelected}
            className="sr-only"
            aria-label={t.dashboard.formHelper.uploadFiles}
          />
        </div>

        {files.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-text-faint">{t.dashboard.formHelper.secureLine}</p>
            <ul className="flex flex-col gap-2">
              {files.map((file) => (
                <li
                  key={file.stored.id}
                  className="flex items-center justify-between gap-3 rounded-[--radius-md] border border-border bg-surface-2 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      className="h-5 w-5 flex-shrink-0 text-text-muted"
                      fill="currentColor"
                    >
                      <path d="M5 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.414A2 2 0 0 0 16.414 6L13 2.586A2 2 0 0 0 11.586 2H5Z" />
                    </svg>
                    <span className="truncate text-base text-text">{file.name}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3">
                    {file.isPdf && (
                      <Link
                        href={`/form?src=${encodeURIComponent(file.stored.id)}`}
                        className="text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-focus"
                      >
                        {t.dashboard.formHelper.openInFiller}
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => removeFile(file.stored.id)}
                      className="text-sm font-medium text-text-muted hover:text-text focus-visible:outline-none"
                    >
                      {t.common.dismiss}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {pdfFiles.length > 0 && (
              <p className="text-sm text-text-faint">{t.dashboard.formHelper.openInFiller}</p>
            )}
          </div>
        )}

        {messages.length === 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-semibold text-text-muted">
              {t.dashboard.formHelper.suggestionsLabel}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setQuery(suggestion)}
                  className="flex items-start gap-3 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-left text-base font-semibold text-text transition hover:border-harbor-300 focus-visible:outline-none focus-visible:shadow-focus"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── CHAT CONVERSATION (directly under the options) ─────────────── */}
      <div
        className="mt-6 mb-4 flex min-h-[200px] flex-col gap-4"
        aria-live="polite"
        aria-busy={loading}
      >
        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div
              key={i}
              className="ml-auto max-w-[80%] rounded-[--radius-md] bg-clay-100 px-5 py-4 text-base text-clay-900"
            >
              {msg.content}
            </div>
          ) : msg.isError ? (
            <div
              key={i}
              role="alert"
              className="mr-auto max-w-[90%] rounded-[--radius-md] bg-danger-50 px-5 py-4 text-base font-medium text-danger-700 ring-1 ring-danger-100"
            >
              {msg.content}
            </div>
          ) : (
            <div
              key={i}
              className="mr-auto max-w-[90%] whitespace-pre-wrap rounded-[--radius-md] border border-border bg-surface px-5 py-4 text-base text-text"
            >
              {msg.content}
            </div>
          ),
        )}
        {loading && (
          <div className="mr-auto rounded-[--radius-md] border border-border bg-surface px-5 py-4 text-base text-text-muted">
            {t.dashboard.formHelper.thinking}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="form-assist-input" className="sr-only">
          {t.dashboard.formHelper.ask}
        </label>
        <input
          id="form-assist-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.dashboard.formHelper.placeholder}
          className="w-full flex-1 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-4 text-lg text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40"
        >
          {loading ? t.dashboard.formHelper.thinking : t.dashboard.formHelper.send}
        </button>
      </form>
    </div>
  );
}
