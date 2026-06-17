"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import DocumentPreview from "@/components/DocumentPreview";
import type { Document } from "@/lib/types";

interface Props {
  documents: Document[];
  userId: string;
}

// Document-type values map 1:1 to t.dashboard.documents.types.* keys.
const DOC_TYPE_VALUES = [
  "passport",
  "i-94",
  "ead",
  "birth_certificate",
  "status_letter",
  "other",
] as const;
type DocTypeValue = (typeof DOC_TYPE_VALUES)[number];

function isPdfDoc(doc: Document): boolean {
  if (doc.mime_type) return doc.mime_type.includes("pdf");
  return /\.pdf$/i.test(doc.file_name);
}

// Best-effort guess of which document this is, from the file name. Falls back to
// "other"; always editable by the user.
function detectDocType(fileName: string): DocTypeValue {
  const n = fileName.toLowerCase();
  if (/passport/.test(n)) return "passport";
  if (/i[\s_-]?94/.test(n)) return "i-94";
  if (/\bead\b|work[\s_-]?permit|employment[\s_-]?authoriz/.test(n)) return "ead";
  if (/birth/.test(n)) return "birth_certificate";
  if (/status|letter|orr/.test(n)) return "status_letter";
  return "other";
}

interface PreviewState {
  url: string;
  fileName: string;
  isPdf: boolean;
}

export default function DocumentsVault({ documents: initial, userId }: Props) {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<Document[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function docTypeLabel(value: string | null): string {
    const key = (DOC_TYPE_VALUES as readonly string[]).includes(value ?? "")
      ? (value as DocTypeValue)
      : "other";
    return t.dashboard.documents.types[key];
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const supabase = createClient();
    const path = `${userId}/${Date.now()}_${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from("user-documents")
      .upload(path, file);

    if (uploadError) {
      alert("Upload failed: " + uploadError.message);
      setUploading(false);
      return;
    }

    // Auto-detect best-effort document type from the file name on upload.
    const detected = detectDocType(file.name);

    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .insert({
        user_id: userId,
        file_name: file.name,
        file_path: path,
        file_size: file.size,
        mime_type: file.type,
        document_type: detected,
      })
      .select()
      .single();

    if (dbError) {
      alert("Failed to save document record.");
      setUploading(false);
      return;
    }

    setDocs((d) => [doc as Document, ...d]);
    setUploading(false);

    // Trigger Claude vision extraction
    setExtracting(doc.id);
    try {
      await fetch("/api/documents/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: doc.id, filePath: path, mimeType: file.type }),
      });
      // Refresh doc to show extracted fields
      const { data: updated } = await supabase
        .from("documents")
        .select("*")
        .eq("id", doc.id)
        .single();
      if (updated) {
        setDocs((d) => d.map((x) => (x.id === doc.id ? (updated as Document) : x)));
      }
    } catch {
      // Non-blocking — extraction failed silently
    } finally {
      setExtracting(null);
    }

    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleDelete(doc: Document) {
    if (!confirm(t.dashboard.documents.deleteConfirm)) return;

    const supabase = createClient();
    await supabase.storage.from("user-documents").remove([doc.file_path]);
    await supabase.from("documents").delete().eq("id", doc.id);
    setDocs((d) => d.filter((x) => x.id !== doc.id));
  }

  async function handleTypeChange(docId: string, type: string) {
    const supabase = createClient();
    await supabase.from("documents").update({ document_type: type }).eq("id", docId);
    setDocs((d) => d.map((x) => (x.id === docId ? { ...x, document_type: type } : x)));
  }

  // Open an ephemeral, in-memory preview. The file is fetched as a blob and
  // turned into an object URL; nothing extra is persisted.
  async function handleOpen(doc: Document) {
    setOpening(doc.id);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from("user-documents")
        .download(doc.file_path);
      if (error || !data) {
        alert("Could not open this document.");
        return;
      }
      const url = URL.createObjectURL(data);
      setPreview({ url, fileName: doc.file_name, isPdf: isPdfDoc(doc) });
    } catch {
      alert("Could not open this document.");
    } finally {
      setOpening(null);
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  return (
    <div>
      <h2 className="mb-2 font-display text-2xl font-bold text-text md:text-3xl">
        {t.dashboard.documents.title}
      </h2>
      <p className="mb-4 text-lg text-text-muted">{t.dashboard.documents.subtitle}</p>
      <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-success-50 px-4 py-2 text-sm font-medium text-success-700 ring-1 ring-success-100">
        <svg
          aria-hidden="true"
          className="h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {t.dashboard.documents.secureLine}
      </div>

      {/* Upload zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t.dashboard.documents.upload}
        className={`mb-8 flex cursor-pointer flex-col items-center justify-center rounded-[--radius-lg] border-2 border-dashed p-8 text-center transition focus-visible:outline-none focus-visible:shadow-focus md:p-12 ${
          dragging ? "border-harbor-400 bg-harbor-50" : "border-border-strong bg-surface-2"
        }`}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file && fileRef.current) {
            const dt = new DataTransfer();
            dt.items.add(file);
            fileRef.current.files = dt.files;
            fileRef.current.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }}
      >
        <div
          aria-hidden="true"
          className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-harbor-50 text-harbor-600"
        >
          <svg
            className="h-7 w-7"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m17 8-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
        </div>
        <p className="font-semibold text-text">
          {uploading ? t.dashboard.documents.extracting : t.dashboard.documents.dragDrop}
        </p>
        <p className="mt-1 text-sm text-text-muted">{t.dashboard.documents.supportedTypes}</p>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="hidden"
          onChange={handleUpload}
          disabled={uploading}
        />
      </div>

      {/* Document list */}
      {docs.length === 0 ? (
        <div className="rounded-[--radius-lg] border border-border bg-surface p-8 text-center md:p-12">
          <div
            aria-hidden="true"
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-harbor-50 text-harbor-600"
          >
            <svg
              className="h-8 w-8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
            </svg>
          </div>
          <h3 className="font-display text-xl font-bold text-text">
            {t.dashboard.documents.noDocuments}
          </h3>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm transition-shadow hover:shadow-md md:p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-display text-lg font-bold text-text">
                    {doc.file_name}
                  </p>
                  <p className="text-sm text-text-faint">
                    {doc.file_size ? `${Math.round(doc.file_size / 1024)} KB` : ""} ·{" "}
                    {new Date(doc.uploaded_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => handleOpen(doc)}
                    disabled={opening === doc.id}
                    aria-label={`${t.dashboard.documents.open} ${doc.file_name}`}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface px-4 py-2 text-sm font-semibold text-text transition hover:bg-surface-2 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    {opening === doc.id
                      ? t.dashboard.documents.extracting
                      : t.dashboard.documents.open}
                  </button>
                  <button
                    onClick={() => handleDelete(doc)}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-[--radius-md] border-2 border-danger-100 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700 transition hover:bg-danger-100 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
                    aria-label={t.common.cancel}
                  >
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <label
                  className="mb-1.5 block text-sm font-semibold text-text-muted"
                  htmlFor={`type-${doc.id}`}
                >
                  {t.dashboard.documents.detectedType}
                </label>
                <select
                  id={`type-${doc.id}`}
                  value={
                    (DOC_TYPE_VALUES as readonly string[]).includes(doc.document_type ?? "")
                      ? (doc.document_type as string)
                      : "other"
                  }
                  onChange={(e) => handleTypeChange(doc.id, e.target.value)}
                  className="w-full max-w-xs rounded-[--radius-md] border-2 border-border bg-surface px-4 py-3 text-base text-text transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                >
                  {DOC_TYPE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {docTypeLabel(value)}
                    </option>
                  ))}
                </select>
              </div>

              {extracting === doc.id && (
                <p className="mt-3 text-sm font-medium text-harbor-600 animate-pulse">
                  {t.dashboard.documents.extracting}
                </p>
              )}

              {doc.extracted_fields && Object.keys(doc.extracted_fields).length > 0 && (
                <div className="mt-3 rounded-[--radius-md] border border-border bg-surface-2 p-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {Object.entries(doc.extracted_fields).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-text-faint">{k}</dt>
                        <dd className="text-sm font-medium text-text">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {preview && (
        <DocumentPreview
          url={preview.url}
          fileName={preview.fileName}
          isPdf={preview.isPdf}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
