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
import type { FormMeta } from "./page";
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
  valueForField,
  type FieldFlag,
  type ProfileValues,
} from "@/lib/formFill";
import {
  bytesToB64,
  b64ToBytes,
  deleteForm,
  getProgress,
  progressKey,
  readAllProgress,
  saveForm,
  type SavedForm,
} from "@/lib/autofill/formProgress";

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
  help?: string; // plain-language "what to put here" (from Haiku)
}

const RENDER_SCALE = 1.5;

// A word from the rendered text layer, positioned in CANVAS pixels (top-left
// origin). x = left edge, y = baseline, w = width, h = approx glyph height.
interface TextItem { str: string; x: number; y: number; w: number; h: number }

// Visible labels we recognize on a form, mapped to a canonical key that
// valueForField()/the sensitive check understand. Order matters (specific first).
const LABEL_PATTERNS: { re: RegExp; key: string }[] = [
  { re: /\b(a-?number|alien (registration )?number|uscis( online)? account|receipt number)\b/i, key: "__sensitive" },
  { re: /\b(social security( number)?|ssn)\b/i, key: "__sensitive" },
  { re: /\bsignature\b/i, key: "__sensitive" },
  { re: /\b(family name|last name|surname)\b/i, key: "last name" },
  { re: /\b(given name|first name|forename)\b/i, key: "first name" },
  { re: /\b(full|legal|applicant|your) name\b/i, key: "full name" },
  { re: /\b(date of birth|birth date|dob)\b/i, key: "date of birth" },
  { re: /\b(country of birth|country of citizenship|nationality)\b/i, key: "country" },
  { re: /\b(mailing|street|home)? ?address\b/i, key: "address" },
  { re: /\b(city or town|city|town)\b/i, key: "city" },
  { re: /\b(state|province)\b/i, key: "state" },
  { re: /\b(zip( ?code)?|postal code)\b/i, key: "zip" },
  { re: /\b(telephone|phone|mobile|cell)( number)?\b/i, key: "phone" },
  { re: /\b(date of arrival|arrival date|date of (last )?entry)\b/i, key: "arrival" },
];

// Build editable overlay fields from the rendered text layer: find each known
// label and place an input in the blank space to its right, auto-filled from the
// profile. This is what lets us fill ANY PDF — including XFA (USCIS) and flat
// scans — because it never reads the PDF's hidden form fields.
function detectLabelFields(
  pageTexts: TextItem[][],
  pages: RenderedPage[],
  values: ProfileValues,
): FieldBox[] {
  const out: FieldBox[] = [];
  let idc = 0;
  for (let pi = 0; pi < pageTexts.length; pi++) {
    const pageW = pages[pi]?.width ?? 1000;
    const items = (pageTexts[pi] || []).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    // Group items into lines (similar baseline y).
    const lines: { y: number; items: TextItem[] }[] = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(4, it.h * 0.6)) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const line of lines) {
      const li = line.items.slice().sort((a, b) => a.x - b.x);
      for (let k = 0; k < li.length; k++) {
        // Try windows of up to 4 words for a label match.
        let matched: { re: RegExp; key: string } | null = null;
        let endIdx = k;
        for (let w = 0; w < 4 && k + w < li.length; w++) {
          const text = li.slice(k, k + w + 1).map((x) => x.str).join(" ").replace(/\s+/g, " ").trim();
          const m = LABEL_PATTERNS.find((p) => p.re.test(text));
          if (m) { matched = m; endIdx = k + w; break; }
        }
        if (!matched) continue;
        const labelItem = li[endIdx];
        const labelEndX = labelItem.x + labelItem.w;
        const next = li.find((x) => x.x > labelEndX + 8);
        const rightBound = next ? next.x - 6 : pageW * 0.95;
        const left = labelEndX + 10;
        const width = rightBound - left;
        if (width < 45) { k = endIdx; continue; } // no room to the right → skip
        const h = Math.max(12, Math.min(labelItem.h, 22));
        let flag: FieldFlag;
        let value = "";
        if (matched.key === "__sensitive") {
          flag = "sensitive";
        } else {
          value = valueForField(matched.key, values) ?? "";
          flag = value ? "auto" : "missing";
        }
        out.push({
          id: `lbl-${pi}-${idc++}`,
          name: li.slice(k, endIdx + 1).map((x) => x.str).join(" ").trim().slice(0, 60),
          pageIndex: pi,
          left,
          top: labelItem.y - h,
          width: Math.min(width, pageW * 0.55),
          height: Math.round(h * 1.5),
          flag,
          value,
          kind: "flat",
        });
        k = endIdx;
        if (out.length >= 60) return out;
      }
    }
  }
  return out;
}

// The visible label/context near a field box (canvas px) — what we hand to Haiku
// so it knows what each field is, even when the PDF's own field name is a
// meaningless code (e.g. the W-9's "f1_01"). Looks left on the same row first,
// then above the field.
function contextFor(box: FieldBox, items: TextItem[] | undefined): string {
  if (box.id.startsWith("lbl-") && box.name && box.name !== "note") return box.name;
  if (!items || items.length === 0) return box.name && box.name !== "note" ? box.name : "";
  const rowTop = box.top - box.height * 0.6;
  const rowBot = box.top + box.height * 1.6;
  const left = items
    .filter((t) => t.y >= rowTop && t.y <= rowBot && t.x + t.w <= box.left + 6)
    .sort((a, b) => a.x - b.x);
  let label = left.slice(-7).map((t) => t.str).join(" ").trim();
  if (!label) {
    const above = items
      .filter((t) => t.y < box.top && t.y > box.top - box.height * 3 && Math.abs(t.x - box.left) < Math.max(box.width, 60))
      .sort((a, b) => b.y - a.y);
    label = above.slice(0, 7).map((t) => t.str).join(" ").trim();
  }
  if (!label && box.name && box.name !== "note") label = box.name;
  return label.replace(/\s+/g, " ").slice(0, 160);
}

// Clean, short display name for a field BEFORE Haiku replies — turns the form's
// raw legalese into something readable. Haiku later replaces it with an even
// simpler, plain-language label.
const KEY_DISPLAY: Record<string, string> = {
  "__sensitive": "Sensitive number",
  "last name": "Last name",
  "first name": "First name",
  "full name": "Full name",
  "date of birth": "Date of birth",
  country: "Country",
  address: "Address",
  city: "City",
  state: "State",
  zip: "ZIP code",
  phone: "Phone number",
  arrival: "Date of arrival",
};
function cleanLabel(raw: string): string {
  if (!raw) return "Form field";
  const m = LABEL_PATTERNS.find((p) => p.re.test(raw));
  if (m && KEY_DISPLAY[m.key]) return KEY_DISPLAY[m.key];
  const cleaned = raw.replace(/^[\d.\s)(–-]+/, "").trim();
  const short = cleaned.split(/\s+/).slice(0, 4).join(" ");
  return short || "Form field";
}

export default function FormFillClient({
  profile,
  formMeta = { needsAttorney: false, applyLink: "" },
}: {
  profile: Profile;
  formMeta?: FormMeta;
}) {
  const { t } = useTranslation();
  const ff = t.dashboard.formFill;
  const searchParams = useSearchParams();

  const srcId = searchParams.get("src");
  const benefitId = searchParams.get("benefit");
  const formName = searchParams.get("form");
  const mode = searchParams.get("mode"); // "fill" = came from "Fill Out with AI"

  const [status, setStatus] = useState<
    "loading" | "fetching-official" | "ready" | "portal" | "error" | "need-upload"
  >("loading");
  // When the real benefit is applied for through a portal/site (no fillable
  // PDF), we surface a clean panel instead of the sample form.
  const [portalLink, setPortalLink] = useState<string>("");
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [fields, setFields] = useState<FieldBox[]>([]);
  const [isFlat, setIsFlat] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [hintDismissed, setHintDismissed] = useState(false);
  // Mandatory review checkbox (present when mode=fill).
  const [reviewChecked, setReviewChecked] = useState(false);
  // Track manually edited field IDs so we never overwrite them on re-render.
  const editedIds = useRef(new Set<string>());

  // Hold the raw PDF bytes in memory so we can fill + save without re-fetching.
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  // A PDF the user uploaded in the "Fill a Form" tab (in memory only). Takes
  // precedence over any benefit/sample source.
  const uploadedRef = useRef<{ bytes: Uint8Array; name: string } | null>(null);
  const formInputRef = useRef<HTMLInputElement | null>(null);
  // AI mapping pass (Haiku): runs once per form, after the deterministic fill.
  const aiDoneRef = useRef(false);
  const pageTextsRef = useRef<TextItem[][]>([]);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [formSummary, setFormSummary] = useState("");
  // Save / resume progress (browser-local).
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedForms, setSavedForms] = useState<SavedForm[]>([]);

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
      } finally {
        // Signal (success OR failure) that document fields are settled, so the
        // AI mapping pass runs with the richest data available.
        if (!cancelled) setDocsLoaded(true);
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
      // 1) Get the bytes. Source order:
      //    (1) uploaded file (in memory) takes precedence;
      //    (2) the REAL official form via the server proxy (dodges CORS) — the
      //        proxy may instead say this benefit is portal-only;
      //    (3) only if the proxy errors entirely, the bundled sample.
      let bytes: Uint8Array | null = null;
      let label = "";
      // A PDF the user uploaded in this tab wins over everything else.
      if (uploadedRef.current) {
        bytes = uploadedRef.current.bytes;
        label = uploadedRef.current.name;
      }
      if (!bytes && srcId) {
        const stored = getFormFile(srcId);
        if (stored) {
          const res = await fetch(stored.objectUrl);
          bytes = new Uint8Array(await res.arrayBuffer());
          label = stored.name;
        }
      }

      if (!bytes && benefitId) {
        // Surface the "loading the official form" state during the proxy fetch.
        setStatus("fetching-official");
        try {
          const res = await fetch(
            `/api/form-pdf?benefit=${encodeURIComponent(benefitId)}`,
          );
          const ct = res.headers.get("content-type") || "";
          if (res.ok && ct.includes("application/pdf")) {
            // Real official, fillable form.
            bytes = new Uint8Array(await res.arrayBuffer());
            label = formName || formMeta.benefitName || benefitId;
          } else if (res.ok && ct.includes("application/json")) {
            const data = (await res.json()) as {
              portal?: boolean;
              applyLink?: string;
            };
            if (data.portal) {
              // Portal-only program: clean UI state, NOT the sample, NOT error.
              setPortalLink(data.applyLink || formMeta.applyLink || "");
              setStatus("portal");
              return;
            }
            // Unexpected JSON shape — fall through to the sample below.
          }
          // Non-OK proxy (e.g. 502) -> fall through to the bundled sample.
        } catch {
          // Proxy unreachable -> fall through to the bundled sample.
        }
      }

      // No source resolved (e.g. the "Fill a Form" tab, or a benefit with no
      // fetchable official PDF) → ask the user to upload the form. No sample.
      if (!bytes) {
        setStatus("need-upload");
        return;
      }
      pdfBytesRef.current = bytes;
      setSourceLabel(label);

      // 2) RENDER FIRST with pdfjs-dist (robust). This is what the user actually
      //    sees, so it must not depend on pdf-lib's AcroForm parsing succeeding.
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
      const pageTexts: TextItem[][] = [];
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
        // Capture the text layer (word + position) for label-anchored filling.
        try {
          const tc = await page.getTextContent();
          const tItems: TextItem[] = [];
          for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
            if (!it.str || !it.str.trim() || !it.transform) continue;
            const tr = pdfjs.Util.transform(viewport.transform, it.transform);
            tItems.push({ str: it.str, x: tr[4], y: tr[5], w: (it.width ?? 0) * RENDER_SCALE, h: Math.hypot(tr[2], tr[3]) || 10 });
          }
          pageTexts[i - 1] = tItems;
        } catch {
          pageTexts[i - 1] = [];
        }
        page.cleanup();
      }

      // 3) Read AcroForm fields with pdf-lib — BEST EFFORT, fully guarded. Some
      //    real-world PDFs make pdf-lib throw (e.g. an undefined page-tree node:
      //    "Expected instance of PDFDict, but got instance of undefined"). When
      //    that happens we still show the rendered pages and fall back to a flat
      //    overlay rather than failing the whole screen.
      const acroBoxes: FieldBox[] = [];
      try {
        const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const libFields = pdfDoc.getForm().getFields();
        const docPages = pdfDoc.getPages();
        if (libFields.length > 0) {
          for (const field of libFields) {
            const name = field.getName();
            const ctor = field.constructor.name;
            const kind: FieldBox["kind"] =
              ctor === "PDFCheckBox" ? "checkbox" : "text";
            const widgets = field.acroField.getWidgets();
            widgets.forEach((widget, wi) => {
              const rect = widget.getRectangle(); // PDF points, bottom-left origin
              const pRef = widget.P();
              let pageIndex = docPages.findIndex((p) => p.ref === pRef);
              if (pageIndex < 0) pageIndex = 0;
              const ps = pageScales[pageIndex];
              if (!ps) return;
              const pageHeight = docPages[pageIndex].getHeight();
              const scale = ps.scale;
              const box: FieldBox = {
                id: widgets.length > 1 ? `${name}#${wi}` : name,
                name,
                pageIndex,
                left: rect.x * scale,
                // flip Y: PDF origin bottom-left -> canvas top-left
                top: (pageHeight - rect.y - rect.height) * scale,
                width: rect.width * scale,
                height: rect.height * scale,
                flag: "missing",
                value: "",
                kind,
              };
              // INSTANT fill from the field's VISIBLE label. The PDF's own field
              // name is often a meaningless code (the W-9's "f1_01"), so we read
              // the label printed next to the box. This fills the obvious fields
              // immediately; the Haiku pass refines the rest a moment later.
              if (kind !== "checkbox") {
                const label = contextFor(box, pageTexts[pageIndex]);
                box.name = cleanLabel(label); // readable name (Haiku refines it)
                const resolved = resolveField(label || name, values);
                box.flag = resolved.flag;
                box.value = resolved.value;
              }
              acroBoxes.push(box);
            });
          }
        }
      } catch (e) {
        console.warn("[form-fill] AcroForm parse failed; using label detection:", e);
        acroBoxes.length = 0;
      }

      // Choose field positions: prefer EXACT AcroForm rectangles whenever the PDF
      // has them (Haiku maps the values, so coded names like the W-9's no longer
      // matter). Only fall back to geometric label-anchored spots when there are
      // no form fields at all (XFA-with-text / flat scans). "Please wait" XFA
      // shells have neither → a single positioned input.
      let finalBoxes: FieldBox[];
      let finalFlat: boolean;
      const labelBoxes = acroBoxes.length === 0 ? detectLabelFields(pageTexts, rendered, values) : [];
      if (acroBoxes.length > 0) {
        finalBoxes = acroBoxes;
        finalFlat = false;
      } else if (labelBoxes.length > 0) {
        finalBoxes = labelBoxes;
        finalFlat = true;
      } else {
        const p0 = rendered[0];
        finalBoxes = p0
          ? [{
              id: "flat-note", name: "note", pageIndex: 0,
              left: p0.width * 0.1, top: p0.height * 0.12,
              width: p0.width * 0.8, height: 28,
              flag: "missing", value: "", kind: "flat",
            }]
          : [];
        finalFlat = true;
      }

      // Restore saved progress for THIS exact form (values the user typed last
      // time win over auto-fill, and are marked edited so Haiku won't change them).
      const saved = getProgress(progressKey(label, bytes.length));
      if (saved) {
        for (const b of finalBoxes) {
          const v = saved.values[b.id];
          if (v) {
            b.value = v;
            if (b.flag !== "sensitive") b.flag = "auto";
            editedIds.current.add(b.id);
          }
        }
        setSavedAt(saved.savedAt);
      } else {
        setSavedAt(null);
      }

      pageTextsRef.current = pageTexts;
      aiDoneRef.current = false;
      setIsFlat(finalFlat);
      setPages(rendered);
      setFields(finalBoxes);
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
    editedIds.current.add(id);
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, value } : f)));
  }

  // ── AI mapping pass (Haiku) ──────────────────────────────────────────────
  // Hand every detected field's nearby label + the user's data to Haiku, which
  // decides what value belongs in each. Runs ONCE per form, after the fast
  // deterministic pass, and only overrides fields the user hasn't edited.
  async function enhanceWithAI(boxes: FieldBox[], texts: TextItem[][], data: ProfileValues) {
    const fillable = boxes.filter((b) => b.kind !== "checkbox" && b.id !== "flat-note");
    if (fillable.length === 0) return;
    setFormSummary("");
    const reqFields = fillable.map((b) => ({ id: b.id, label: contextFor(b, texts[b.pageIndex]) }));
    // First-page visible text helps Haiku identify the form + read each field in
    // context (improves accuracy and powers the "About this form" summary).
    const formText = (texts[0] ?? []).map((t) => t.str).join(" ").replace(/\s+/g, " ").slice(0, 2500);
    try {
      const res = await fetch("/api/form-assist/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: reqFields, data, formText }),
      });
      if (!res.ok) return; // keep the deterministic fill
      const json = (await res.json()) as {
        mappings?: { id: string; value: string | null; sensitive: boolean; label?: string; help?: string }[];
        summary?: string;
      };
      if (json.summary) setFormSummary(json.summary);
      const map = new Map((json.mappings ?? []).map((m) => [m.id, m]));
      setFields((prev) =>
        prev.map((b) => {
          const m = map.get(b.id);
          if (!m) return b;
          // Always adopt Haiku's plain-language name + help, even for fields the
          // user has edited (labels are display-only, never their typed value).
          const labelled = {
            ...b,
            name: m.label || b.name,
            help: m.help || b.help,
          };
          if (editedIds.current.has(b.id)) return labelled; // keep their value
          if (m.sensitive) return { ...labelled, value: "", flag: "sensitive" as FieldFlag };
          if (m.value) return { ...labelled, value: m.value, flag: "auto" as FieldFlag };
          return labelled; // model found no value → keep what we had, nicer label
        }),
      );
    } catch {
      /* network error → keep the deterministic fill */
    }
  }

  // Trigger the AI pass once the form is rendered AND document fields are merged.
  useEffect(() => {
    if (status !== "ready" || !docsLoaded || aiDoneRef.current) return;
    aiDoneRef.current = true;
    void enhanceWithAI(fields, pageTextsRef.current, values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, docsLoaded]);

  // User picked a PDF of the form they want filled. Kept in memory only.
  async function onPickForm(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const buf = new Uint8Array(await file.arrayBuffer());
        uploadedRef.current = { bytes: buf, name: file.name };
        editedIds.current = new Set();
        setFields([]);
        setPages([]);
        setPortalLink("");
        setStatus("loading");
        void load();
      } else {
        setStatus("error");
      }
    }
    if (formInputRef.current) formInputRef.current.value = "";
  }

  // Load a bundled real government form so users can try the filler on an actual
  // form with no upload and no login.
  async function loadSample(path: string, name: string) {
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error("sample fetch failed");
      const buf = new Uint8Array(await res.arrayBuffer());
      uploadedRef.current = { bytes: buf, name };
      editedIds.current = new Set();
      setFields([]);
      setPages([]);
      setPortalLink("");
      setStatus("loading");
      void load();
    } catch {
      setStatus("error");
    }
  }

  // ── Save / resume progress (browser-local) ──────────────────────────────
  // Surface saved forms on the upload screen (localStorage read on transition).
  useEffect(() => {
    if (status === "need-upload" || status === "ready") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedForms(readAllProgress());
    }
  }, [status]);

  function handleSaveProgress() {
    if (!pdfBytesRef.current) return;
    const vals: Record<string, string> = {};
    for (const f of fields) if (f.value) vals[f.id] = f.value;
    const ok = saveForm({
      key: progressKey(sourceLabel || "form", pdfBytesRef.current.length),
      label: sourceLabel || "Your form",
      values: vals,
      bytesB64: bytesToB64(pdfBytesRef.current),
      savedAt: Date.now(),
    });
    if (ok) {
      setSavedAt(Date.now());
      setSavedForms(readAllProgress());
    }
  }

  function resumeSaved(saved: SavedForm) {
    if (!saved.bytesB64) return;
    uploadedRef.current = { bytes: b64ToBytes(saved.bytesB64), name: saved.label };
    editedIds.current = new Set();
    setFormSummary("");
    setFields([]);
    setPages([]);
    setPortalLink("");
    setStatus("loading");
    void load();
  }

  function discardSaved(key: string) {
    deleteForm(key);
    setSavedForms(readAllProgress());
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
          // Multi-widget fields share a name; the id is `${name}#${widget}`.
          const baseName = box.id.includes("#") ? box.id.split("#")[0] : box.id;
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
    auto: "border-success-500 bg-success-100 text-success-900 font-semibold",
    missing: "border-caution-400 bg-caution-50 text-caution-800",
    sensitive: "border-danger-400 bg-danger-50 text-danger-800",
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
  const textFields = useMemo(
    () => fields.filter((f) => f.kind !== "checkbox"),
    [fields],
  );
  // Fields the user can fill in-app = everything except sensitive (those are
  // entered on the official site, never here).
  const fillableFields = useMemo(
    () => textFields.filter((f) => f.flag !== "sensitive"),
    [textFields],
  );
  // "Filled" = ANY fillable field that now has a value — whether auto-filled OR
  // typed in by hand. (The old code only counted auto-filled, so the counter
  // never moved when you typed.)
  const filledCount = useMemo(
    () => fillableFields.filter((f) => f.value.trim() !== "").length,
    [fillableFields],
  );
  const fillableTotal = fillableFields.length;
  const missingCount = useMemo(
    () => fillableFields.filter((f) => f.value.trim() === "").length,
    [fillableFields],
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

        <h1 className="font-display text-2xl font-bold text-text md:text-3xl">
          {formMeta.benefitName ? `Fill Out: ${formMeta.benefitName}` : ff.title}
        </h1>
        <p className="mt-1 text-lg text-text-muted">{ff.intro}</p>
        {sourceLabel && status === "ready" && (
          <p className="mt-1 text-sm text-text-faint">{sourceLabel}</p>
        )}

        {/* Upload input (used by the upload state and "different form" link). */}
        <input
          ref={formInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={onPickForm}
        />
        {status === "ready" && (
          <button
            type="button"
            onClick={() => formInputRef.current?.click()}
            className="mt-2 text-sm font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none"
          >
            Upload a different form
          </button>
        )}

        {/* Attorney banner */}
        {formMeta.needsAttorney && (
          <div className="mt-4 flex items-start gap-3 rounded-[--radius-md] border border-review-100 bg-review-50 px-5 py-4">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-5 w-5 flex-shrink-0 text-review-600">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-bold text-review-700">Attorney review recommended</p>
              <p className="mt-0.5 text-sm text-review-700">
                This is an immigration or legal form. A licensed attorney or DOJ-accredited
                representative should review it before you submit anything.
              </p>
            </div>
          </div>
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

        {(status === "loading" || status === "fetching-official") && (
          <div
            className="mt-8 rounded-[--radius-lg] border border-border bg-surface p-10 text-center text-lg text-text-muted"
            aria-live="polite"
          >
            {status === "fetching-official" ? ff.officialFormLoading : ff.loading}
          </div>
        )}

        {status === "portal" && (
          <div className="mt-8 rounded-[--radius-lg] border border-harbor-100 bg-harbor-50 p-8 text-center">
            <p className="text-lg font-medium text-harbor-700">
              {ff.statePortalOnly}
            </p>
            {(portalLink || formMeta.applyLink) && (
              <a
                href={portalLink || formMeta.applyLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-base font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
              >
                {ff.openOfficialSite}
              </a>
            )}
          </div>
        )}

        {status === "need-upload" && (
          <button
            type="button"
            onClick={() => formInputRef.current?.click()}
            className="mt-8 flex w-full flex-col items-center justify-center gap-2 rounded-[--radius-lg] border-2 border-dashed border-harbor-300 bg-surface-2 px-6 py-12 text-center transition hover:border-harbor-500 hover:bg-harbor-50 focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span aria-hidden="true" className="mb-1 flex h-14 w-14 items-center justify-center rounded-full bg-harbor-50 text-harbor-600">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
              </svg>
            </span>
            <span className="text-lg font-semibold text-text">Upload the PDF of the form you want to fill out</span>
            <span className="max-w-md text-sm text-text-muted">
              We&apos;ll fill in what we can from your saved information and flag anything sensitive for you to enter yourself. Your file stays in your browser — we never upload or store it.
            </span>
            <span className="mt-3 inline-flex items-center gap-2 rounded-[--radius-md] bg-primary px-5 py-3 text-base font-semibold text-on-primary">Choose a PDF</span>
          </button>
        )}
        {status === "need-upload" && (
          <div className="mt-3 text-center text-sm text-text-muted">
            <p>Or try a real government form, no upload needed:</p>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => loadSample("/forms/irs-w9-taxpayer-info.pdf", "IRS Form W-9")} className="font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none">
                IRS W-9
              </button>
              <button type="button" onClick={() => loadSample("/forms/uscis-i-765-work-permit.pdf", "USCIS Form I-765 (Work Permit)")} className="font-semibold text-link underline-offset-2 hover:underline focus-visible:outline-none">
                USCIS I-765 (Work Permit)
              </button>
            </div>
          </div>
        )}
        {status === "need-upload" && savedForms.length > 0 && (
          <div className="mx-auto mt-5 max-w-md rounded-[--radius-md] border border-success-200 bg-success-50 p-4">
            <p className="text-center text-sm font-medium text-text">Forms in progress</p>
            <ul className="mt-3 flex flex-col gap-2">
              {savedForms.map((sf) => (
                <li key={sf.key} className="flex items-center justify-between gap-3 rounded-[--radius-md] border border-success-200 bg-surface px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text">{sf.label}</p>
                    <p className="text-xs text-text-muted">
                      {Object.keys(sf.values).length} field{Object.keys(sf.values).length === 1 ? "" : "s"} filled
                      {sf.bytesB64 ? "" : " · re-upload to resume"}
                    </p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    {sf.bytesB64 && (
                      <button type="button" onClick={() => resumeSaved(sf)} className="rounded-[--radius-md] bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition hover:bg-primary-hover focus-visible:outline-none focus-visible:shadow-focus">
                        Resume
                      </button>
                    )}
                    <button type="button" onClick={() => discardSaved(sf.key)} aria-label={`Discard ${sf.label}`} className="text-xs text-text-muted underline-offset-2 hover:underline focus-visible:outline-none">
                      Discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
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
            {/* ── "About this form" summary (Haiku-identified) ──────────── */}
            <div className="lg:col-span-2 rounded-[--radius-lg] border border-harbor-200 bg-harbor-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-harbor-700">About this form</p>
              <p className="mt-1 text-sm text-text">
                {formSummary || `${sourceLabel || "Your form"} — reading the form and filling what we can from your saved information…`}
              </p>
              <p className="mt-2 text-xs text-text-muted">
                Green = filled for you. Yellow = needs your input. Red = sensitive (enter it yourself on the official site). Check every field before you use the form.
              </p>
            </div>

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
                          className={`absolute rounded-sm px-1 text-[12px] leading-tight outline-none focus:z-10 focus:shadow-focus ${flagTone[f.flag]}`}
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
              <div className="sticky top-6 rounded-[--radius-lg] border border-border bg-surface shadow-sm">
                <div className="p-5">
                  <h2 className="font-display text-lg font-bold text-text">{ff.reviewAll}</h2>

                  {/* Progress bar — counts every filled field (auto + typed),
                      out of the fields you can fill here (sensitive ones are
                      entered on the official site and excluded). */}
                  {fillableTotal > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                        <span>{filledCount} of {fillableTotal} fields filled</span>
                        <span>{missingCount > 0 ? `${missingCount} to fill in` : "All filled!"}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-sand-200">
                        <div
                          className="h-full rounded-full bg-success-500 transition-all"
                          style={{ width: `${Math.round((filledCount / fillableTotal) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

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
                        aria-label={t.common.close}
                        className="-mr-1 -mt-0.5 flex-shrink-0 rounded p-0.5 text-harbor-700/70 transition hover:text-harbor-700 focus-visible:outline-none focus-visible:shadow-focus"
                      >
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
                          <path d="M6.3 5.3a1 1 0 0 1 1.4 0L10 7.58l2.3-2.3a1 1 0 1 1 1.4 1.42L11.42 9l2.3 2.3a1 1 0 0 1-1.42 1.4L10 10.42l-2.3 2.3a1 1 0 0 1-1.4-1.42L8.58 9l-2.3-2.3a1 1 0 0 1 0-1.4Z" />
                        </svg>
                      </button>
                    </div>
                  )}

                  <ul className="mt-4 flex flex-col gap-4">
                    {textFields.map((f) => (
                      <li key={f.id} className={`rounded-[--radius-md] border p-3 ${
                        f.flag === "sensitive"
                          ? "border-danger-200 bg-danger-50/50"
                          : f.flag === "auto"
                          ? "border-success-200 bg-success-50/30"
                          : "border-caution-200 bg-caution-50/30"
                      }`}>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
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
                              ? "Auto-filled"
                              : f.flag === "sensitive"
                              ? "Sensitive"
                              : "Fill in"}
                          </span>
                        </div>
                        {f.help && (
                          <p className="mb-2 text-xs text-text-muted">{f.help}</p>
                        )}
                        {f.flag === "sensitive" ? (
                          <div>
                            <p className="mb-2 text-xs font-medium text-danger-700">
                              Enter this directly on the official site — we never see it.
                            </p>
                            {formMeta.applyLink && (
                              <a
                                href={formMeta.applyLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-[--radius-md] border-2 border-danger-200 bg-danger-50 px-3 py-1.5 text-xs font-bold text-danger-700 transition hover:border-danger-400 hover:bg-danger-100 focus-visible:outline-none"
                              >
                                Enter on official site →
                              </a>
                            )}
                          </div>
                        ) : (
                          <input
                            id={`field-${f.id}`}
                            type="text"
                            value={f.value}
                            onChange={(e) => updateField(f.id, e.target.value)}
                            placeholder={f.flag === "missing" ? "Type your answer here" : ""}
                            className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-3 py-2 text-base text-text placeholder-text-faint transition focus:border-harbor-400 focus:outline-none focus-visible:shadow-focus"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Mandatory review + terminal action footer */}
                <div className="border-t border-border bg-sand-50 p-5">
                  {mode === "fill" && (
                    <label className="mb-4 flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={reviewChecked}
                        onChange={(e) => setReviewChecked(e.target.checked)}
                        className="mt-0.5 h-5 w-5 flex-shrink-0 cursor-pointer accent-primary"
                      />
                      <span className="text-sm font-semibold text-text">
                        I have reviewed every field above and confirm the information is correct.
                      </span>
                    </label>
                  )}

                  {mode === "fill" && formMeta.applyLink ? (
                    <>
                      <button
                        type="button"
                        disabled={!reviewChecked || downloading}
                        onClick={async () => {
                          // Preserve the user's answers: download the filled form
                          // first, then hand off to the official application page.
                          await handleDownload();
                          window.open(formMeta.applyLink, "_blank", "noopener,noreferrer");
                        }}
                        className={`inline-flex w-full items-center justify-center gap-2 rounded-[--radius-md] px-6 py-4 text-base font-semibold text-white shadow-sm transition active:scale-[0.98] focus-visible:outline-none ${
                          reviewChecked && !downloading
                            ? "bg-success-600 hover:bg-success-700 hover:shadow-md"
                            : "cursor-not-allowed bg-sand-300 text-sand-500"
                        }`}
                      >
                        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                          <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
                          <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
                        </svg>
                        {downloading ? ff.downloading : "Save my answers & open the official site"}
                      </button>
                      <p className="mt-2 text-xs text-text-faint">
                        We download your filled form first so you keep your answers, then open the official application page in a new tab.
                      </p>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleDownload}
                      disabled={downloading || (mode === "fill" && !reviewChecked)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-[--radius-md] bg-primary px-6 py-4 text-lg font-semibold text-on-primary shadow-sm transition hover:bg-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40"
                    >
                      {downloading ? ff.downloading : ff.download}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleSaveProgress}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-[--radius-md] border-2 border-border bg-surface px-6 py-3 text-sm font-semibold text-text transition hover:bg-canvas focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    {savedAt ? "Progress saved ✓ — save again" : "Save my progress"}
                  </button>
                  {savedAt && (
                    <p className="mt-1.5 text-center text-xs text-text-muted">
                      Saved on this device — you can close the tab and resume later.
                    </p>
                  )}

                  {formMeta.howToApply && mode === "fill" && (
                    <p className="mt-3 text-xs text-text-faint">{formMeta.howToApply}</p>
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
