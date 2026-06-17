"use client";

// Custom PDF form-fill experience.
//
// RENDERING + WORKER (pdfjs-dist 6):
//   We import the ESM build directly (`pdfjs-dist/build/pdf.mjs`) and point
//   GlobalWorkerOptions.workerSrc at a bundler-resolved URL:
//       new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)
//   Next/Turbopack rewrites that URL to an emitted asset, so the worker loads
//   from our own origin (no CDN, no version mismatch) and the page renders.
//   Each page is drawn to a <canvas>; we keep the render scale so we can map
//   PDF field rectangles (PDF points, origin bottom-left) onto canvas pixels
//   (origin top-left) for the highlight overlay.
//
// FIELDS (pdf-lib):
//   pdf-lib reads the AcroForm via getForm().getFields(). For each text field we
//   read its widget rectangle + page index to position an overlay input exactly
//   over the field. If the PDF is FLAT (no AcroForm fields) we fall back to a
//   single positioned input the user can place/type, and we draw that text onto
//   the page with pdf-lib at download time.
//
// FILL / FLAG (lib/formFill):
//   Each field is auto-filled from the user's confirmed profile when we have the
//   data; sensitive fields (SSN, A-Number, passport, bank, etc.) are never
//   auto-filled — flagged + coached; fields with no data are flagged "missing".
//
// PRIVACY: the PDF stays in memory (object URL for uploads, fetch ArrayBuffer
// for the bundled sample). We never upload the file or persist it server-side.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { Profile } from "@/lib/types";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import { getFormFile } from "@/lib/formFileStore";
import { createClient } from "@/lib/supabase/client";
import {
  mergeDocumentFields,
  profileToValues,
  resolveField,
  type FieldFlag,
} from "@/lib/formFill";

// The bundled sample so /form?benefit=... always has a real fillable form to
// demonstrate. See the report for what it is and how to use it.
const SAMPLE_FORM_URL = "/sample-intake-form.pdf";

interface RenderedPage {
  pageIndex: number;
  width: number; // canvas pixel width (= PDF width * scale)
  height: number;
  dataUrl: string; // rendered page image (kept in memory, not persisted)
}

interface FieldBox {
  id: string; // pdf-lib field name (unique key)
  name: string; // display name
  pageIndex: number;
  // Position in canvas pixels (top-left origin) for the overlay.
  left: number;
  top: number;
  width: number;
  height: number;
  flag: FieldFlag;
  value: string;
  kind: "text" | "checkbox" | "flat";
}

const RENDER_SCALE = 1.5;

export default function FormFillClient({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  const ff = t.dashboard.formFill;
  const searchParams = useSearchParams();

  const srcId = searchParams.get("src");
  const benefitId = searchParams.get("benefit");
  const formName = searchParams.get("form");

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [fields, setFields] = useState<FieldBox[]>([]);
  const [isFlat, setIsFlat] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [hintDismissed, setHintDismissed] = useState(false);

  // Hold the raw PDF bytes in memory so we can fill + save without re-fetching.
  const pdfBytesRef = useRef<Uint8Array | null>(null);

  // Build the non-sensitive value bag from the profile (merged with any
  // non-sensitive document fields fetched below).
  const baseValues = useMemo(() => profileToValues(profile), [profile]);
  const [values, setValues] = useState(baseValues);

  // Pull non-sensitive extracted document fields (browser client) to improve
  // auto-fill. Best-effort; never blocks rendering, never reads sensitive nums.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = createClient();
        const {
          data: { user },
        } = await sb.auth.getUser();
        if (!user) return;
        const { data } = await sb
          .from("documents")
          .select("extracted_fields")
          .eq("user_id", user.id);
        if (cancelled || !data) return;
        let merged = baseValues;
        for (const row of data) {
          merged = mergeDocumentFields(
            merged,
            (row as { extracted_fields: Record<string, string> | null }).extracted_fields,
          );
        }
        if (!cancelled) setValues(merged);
      } catch {
        /* keep profile-only values on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseValues]);

  // ── Load + render the PDF ────────────────────────────────────────────────
  const load = useCallback(async () => {
    // Initial state is already "loading", so the first paint is correct without
    // a synchronous setState here. All state updates below happen only after a
    // real async boundary (fetch / pdf parse).
    try {
      // 1) Get the bytes. Uploaded file (in memory) takes precedence; otherwise
      //    the bundled sample (so action-item help always demonstrates).
      let bytes: Uint8Array | null = null;
      let label = "";
      if (srcId) {
        const stored = getFormFile(srcId);
        if (stored) {
          const res = await fetch(stored.objectUrl);
          bytes = new Uint8Array(await res.arrayBuffer());
          label = stored.name;
        }
      }
      if (!bytes) {
        const res = await fetch(SAMPLE_FORM_URL);
        if (!res.ok) throw new Error("sample fetch failed");
        bytes = new Uint8Array(await res.arrayBuffer());
        label = formName || benefitId || "Sample Benefits Intake Form";
      }
      pdfBytesRef.current = bytes;
      setSourceLabel(label);

      // 2) Read fields with pdf-lib first (needed for both AcroForm + flat).
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const form = pdfDoc.getForm();
      const libFields = form.getFields();
      const docPages = pdfDoc.getPages();

      // 3) Render every page with pdfjs-dist to image data URLs (in memory).
      //    Dynamic import keeps pdfjs out of the server bundle.
      const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();

      // pdfjs consumes the buffer — pass a copy so pdfBytesRef stays intact.
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdf = await loadingTask.promise;

      const rendered: RenderedPage[] = [];
      const pageScales: { scale: number; viewHeight: number }[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        rendered.push({
          pageIndex: i - 1,
          width: canvas.width,
          height: canvas.height,
          dataUrl: canvas.toDataURL("image/png"),
        });
        pageScales[i - 1] = { scale: RENDER_SCALE, viewHeight: canvas.height };
        page.cleanup();
      }

      // 4) Build overlay field boxes.
      const boxes: FieldBox[] = [];
      if (libFields.length > 0) {
        setIsFlat(false);
        for (const field of libFields) {
          const name = field.getName();
          const ctor = field.constructor.name;
          const kind: FieldBox["kind"] =
            ctor === "PDFCheckBox" ? "checkbox" : "text";
          const widgets = field.acroField.getWidgets();
          const resolved = resolveField(name, values);
          widgets.forEach((widget, wi) => {
            const rect = widget.getRectangle(); // PDF points, bottom-left origin
            // Which page is this widget on?
            const pRef = widget.P();
            let pageIndex = docPages.findIndex(
              (p) => p.ref === pRef,
            );
            if (pageIndex < 0) pageIndex = 0;
            const ps = pageScales[pageIndex];
            if (!ps) return;
            const pdfPage = docPages[pageIndex];
            const pageHeight = pdfPage.getHeight();
            const scale = ps.scale;
            boxes.push({
              id: widgets.length > 1 ? `${name}#${wi}` : name,
              name,
              pageIndex,
              left: rect.x * scale,
              // flip Y: PDF origin bottom-left -> canvas top-left
              top: (pageHeight - rect.y - rect.height) * scale,
              width: rect.width * scale,
              height: rect.height * scale,
              flag: resolved.flag,
              value: resolved.value,
              kind,
            });
          });
        }
      } else {
        // FLAT PDF fallback: no AcroForm. Provide a single positioned overlay
        // input near the top of page 1 the user can type into; we draw it onto
        // the page with pdf-lib at download time.
        setIsFlat(true);
        const p0 = rendered[0];
        if (p0) {
          boxes.push({
            id: "flat-note",
            name: "note",
            pageIndex: 0,
            left: p0.width * 0.1,
            top: p0.height * 0.12,
            width: p0.width * 0.8,
            height: 28,
            flag: "missing",
            value: "",
            kind: "flat",
          });
        }
      }

      setPages(rendered);
      setFields(boxes);
      setStatus("ready");
    } catch (err) {
      console.error("[form-fill] load failed:", err);
      setStatus("error");
    }
    // values intentionally excluded: auto-fill on first load; later value edits
    // update overlay state directly without re-rendering the PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId, benefitId, formName]);

  useEffect(() => {
    // Kick off loading on a microtask so the heavy PDF parse/render (and its
    // state updates) run off the synchronous effect path, after the first
    // paint of the "loading" state.
    let active = true;
    Promise.resolve().then(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [load]);

  function updateField(id: string, value: string) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, value } : f)));
  }

  // ── Download the filled PDF ──────────────────────────────────────────────
  async function handleDownload() {
    if (!pdfBytesRef.current) return;
    setDownloading(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytesRef.current, {
        ignoreEncryption: true,
      });

      if (!isFlat) {
        const form = pdfDoc.getForm();
        for (const box of fields) {
          // Multi-widget fields share a name; the value is the same per name.
          const baseName = box.id.includes("#") ? box.name : box.id;
          if (box.kind === "checkbox") continue; // checkboxes left to the user
          try {
            const tf = form.getTextField(baseName);
            if (box.value) tf.setText(box.value);
          } catch {
            /* field type changed / not a text field — skip */
          }
        }
      } else {
        // Flat fallback: draw overlay text onto the page with pdf-lib.
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const docPages = pdfDoc.getPages();
        for (const box of fields) {
          if (!box.value) continue;
          const page = docPages[box.pageIndex];
          if (!page) continue;
          const scale = RENDER_SCALE;
          page.drawText(box.value, {
            x: box.left / scale,
            y: page.getHeight() - box.top / scale - box.height / scale + 4,
            size: 11,
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
        }
      }

      const out = await pdfDoc.save();
      const blob = new Blob([out as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (sourceLabel || "form").replace(/\.pdf$/i, "") + "-filled.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[form-fill] download failed:", err);
    } finally {
      setDownloading(false);
    }
  }

  // Flag styling tokens.
  const flagTone: Record<FieldFlag, string> = {
    auto: "border-success-400 bg-success-50/70",
    missing: "border-caution-400 bg-caution-50/70",
    sensitive: "border-danger-400 bg-danger-50/70",
  };
  const flagLabel: Record<FieldFlag, string> = {
    auto: ff.autoFilled,
    missing: ff.missing,
    sensitive: ff.sensitive,
  };
  const flagBadgeTone: Record<FieldFlag, string> = {
    auto: "bg-success-100 text-success-700",
    missing: "bg-caution-100 text-caution-700",
    sensitive: "bg-danger-100 text-danger-700",
  };

  // Count non-sensitive fields still missing a value. When several remain, we
  // nudge the user to upload a document so auto-fill can cover more (sensitive
  // fields are excluded — uploading never fills those).
  const missingCount = useMemo(
    () =>
      fields.filter((f) => f.kind !== "checkbox" && f.flag === "missing").length,
    [fields],
  );
  const showUploadHint = status === "ready" && missingCount >= 2 && !hintDismissed;

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
        <div className="mb-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-focus"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M12.7 5.3a1 1 0 0 1 0 1.4L9.42 10l3.3 3.3a1 1 0 1 1-1.42 1.4l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.4 0Z"
                clipRule="evenodd"
              />
            </svg>
            {t.common.back}
          </Link>
        </div>

        <h1 className="font-display text-2xl font-bold text-text md:text-3xl">{ff.title}</h1>
        <p className="mt-1 text-lg text-text-muted">{ff.intro}</p>
        {sourceLabel && status === "ready" && (
          <p className="mt-1 text-sm text-text-faint">{sourceLabel}</p>
        )}

        {/* Secure line — always near the form per the upload/privacy contract. */}
        <div className="mt-4 inline-flex items-start gap-2 rounded-[--radius-md] bg-success-50 px-4 py-2 text-sm font-medium text-success-700 ring-1 ring-success-100">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 flex-shrink-0" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 1a4.5 4.5 0 0 0-4.5 4.5V8H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 7V5.5a3 3 0 1 0-6 0V8h6Z"
              clipRule="evenodd"
            />
          </svg>
          <span>{ff.secureLine}</span>
        </div>

        {status === "loading" && (
          <div
            className="mt-8 rounded-[--radius-lg] border border-border bg-surface p-10 text-center text-lg text-text-muted"
            aria-live="polite"
          >
            {ff.loading}
          </div>
        )}

        {status === "error" && (
          <div className="mt-8 rounded-[--radius-lg] border border-danger-100 bg-danger-50 p-8 text-center" role="alert">
            <p className="text-lg font-semibold text-danger-700">{ff.loadError}</p>
            <Link
              href="/dashboard"
              className="mt-4 inline-flex items-center justify-center rounded-[--radius-md] bg-primary px-5 py-3 text-base font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover focus-visible:outline-none focus-visible:shadow-focus"
            >
              {ff.openPrompt}
            </Link>
          </div>
        )}

        {status === "ready" && (
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
            {/* ── Rendered pages with positioned overlay inputs ─────────── */}
            <div className="order-2 lg:order-1">
              {isFlat && (
                <p className="mb-3 rounded-[--radius-md] bg-caution-50 px-4 py-3 text-sm font-medium text-caution-700 ring-1 ring-caution-100">
                  {ff.noFields}
                </p>
              )}
              <div className="flex flex-col items-center gap-6">
                {pages.map((pg) => (
                  <div
                    key={pg.pageIndex}
                    className="relative w-full overflow-hidden rounded-[--radius-md] border border-border bg-surface shadow-sm"
                    style={{ maxWidth: pg.width }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={pg.dataUrl}
                      alt={`Page ${pg.pageIndex + 1}`}
                      width={pg.width}
                      height={pg.height}
                      className="block h-auto w-full"
                    />
                    {/* Overlay inputs, positioned as % of the rendered size so
                        they scale with the responsive image. */}
                    {fields
                      .filter((f) => f.pageIndex === pg.pageIndex && f.kind !== "checkbox")
                      .map((f) => (
                        <input
                          key={f.id}
                          type="text"
                          value={f.value}
                          onChange={(e) => updateField(f.id, e.target.value)}
                          aria-label={`${f.name} — ${flagLabel[f.flag]}`}
                          title={`${f.name} — ${flagLabel[f.flag]}`}
                          placeholder={f.flag === "sensitive" ? "" : flagLabel[f.flag]}
                          className={`absolute rounded-sm border-2 px-1 text-[12px] text-text outline-none focus:shadow-focus ${flagTone[f.flag]}`}
                          style={{
                            left: `${(f.left / pg.width) * 100}%`,
                            top: `${(f.top / pg.height) * 100}%`,
                            width: `${(f.width / pg.width) * 100}%`,
                            height: `${(f.height / pg.height) * 100}%`,
                            minHeight: 18,
                          }}
                        />
                      ))}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Review panel: every field listed, editable, flagged ──── */}
            <aside className="order-1 lg:order-2">
              <div className="sticky top-6 rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm">
                <h2 className="font-display text-lg font-bold text-text">{ff.reviewAll}</h2>

                {showUploadHint && (
                  <div className="mt-4 flex items-start gap-2 rounded-[--radius-md] bg-harbor-50 px-3 py-2.5 text-sm text-harbor-700 ring-1 ring-harbor-100">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      className="mt-0.5 h-4 w-4 flex-shrink-0"
                      fill="currentColor"
                    >
                      <path d="M10 2a1 1 0 0 1 .7.3l4 4a1 1 0 0 1-1.4 1.4L11 5.42V12a1 1 0 1 1-2 0V5.42L6.7 7.7a1 1 0 0 1-1.4-1.4l4-4A1 1 0 0 1 10 2Z" />
                      <path d="M4 14a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z" />
                    </svg>
                    <span className="flex-1">
                      <Link
                        href="/dashboard"
                        className="font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-focus"
                      >
                        {ff.uploadHint}
                      </Link>
                    </span>
                    <button
                      type="button"
                      onClick={() => setHintDismissed(true)}
                      aria-label={t.common.close ?? "Dismiss"}
                      className="-mr-1 -mt-0.5 flex-shrink-0 rounded p-0.5 text-harbor-700/70 transition hover:text-harbor-700 focus-visible:outline-none focus-visible:shadow-focus"
                    >
                      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
                        <path d="M6.3 5.3a1 1 0 0 1 1.4 0L10 7.58l2.3-2.3a1 1 0 1 1 1.4 1.42L11.42 9l2.3 2.3a1 1 0 0 1-1.42 1.4L10 10.42l-2.3 2.3a1 1 0 0 1-1.4-1.42L8.58 9l-2.3-2.3a1 1 0 0 1 0-1.4Z" />
                      </svg>
                    </button>
                  </div>
                )}

                <ul className="mt-4 flex flex-col gap-4">
                  {fields
                    .filter((f) => f.kind !== "checkbox")
                    .map((f) => (
                      <li key={f.id}>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <label
                            htmlFor={`field-${f.id}`}
                            className="text-sm font-semibold text-text"
                          >
                            {f.name}
                          </label>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${flagBadgeTone[f.flag]}`}
                          >
                            {f.flag === "auto"
                              ? ff.autoFilled
                              : f.flag === "sensitive"
                              ? ff.sensitive.split("—")[0].trim()
                              : ff.missing.split("—")[0].trim()}
                          </span>
                        </div>
                        <input
                          id={`field-${f.id}`}
                          type="text"
                          value={f.value}
                          onChange={(e) => updateField(f.id, e.target.value)}
                          placeholder={f.flag === "missing" ? ff.missing : ""}
                          className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-3 py-2 text-base text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                        />
                        {f.flag === "sensitive" && (
                          <p className="mt-1 text-xs font-medium text-danger-700">
                            {ff.sensitive}
                          </p>
                        )}
                      </li>
                    ))}
                </ul>

                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloading}
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40"
                >
                  {downloading ? ff.downloading : ff.download}
                </button>
              </div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
