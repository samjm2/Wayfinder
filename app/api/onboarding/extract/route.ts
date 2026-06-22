import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getClaudeClient, SONNET } from "@/lib/claude";
import { EXTRACT_PROMPT, parseExtraction, type DocType } from "@/lib/onboarding/i94Extract";
import { normalizeImageForOcr } from "@/lib/onboarding/ocrImage";

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding document extraction.
//
// The user uploads a photo/PDF of their I-94, EAD, green card, or asylum grant
// letter. A vision model reads ONLY the eligibility-relevant fields and returns
// them with a per-field confidence. We never extract A-Number / SSN / passport /
// financial identifiers — those are sensitive and the deterministic engine does
// not need them. SSN cards are not stored at all.
//
// Prompt + parse/validate/derive (incl. the date-of-birth-vs-entry-date guard)
// live in lib/onboarding/i94Extract.ts so they can be unit-tested against real
// document fixtures. This route only handles auth, file intake, the model call,
// and persisting the uploaded files to the user's private vault.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const MAX_FILES = 4;
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB per file
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF_TYPE = "application/pdf";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload. Please try again." }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Please upload at most ${MAX_FILES} documents at a time.` }, { status: 400 });
  }

  // Build Claude content blocks, and keep each file's bytes so we can persist the
  // uploaded documents to the user's vault after extraction.
  const content: Anthropic.ContentBlockParam[] = [];
  const uploaded: { file: File; bytes: ArrayBuffer; mediaType: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Each file must be under 6 MB. Try a smaller photo." }, { status: 400 });
    }
    const type = file.type;
    const isImage = IMAGE_TYPES.has(type);
    const isPdf = type === PDF_TYPE;
    if (!isImage && !isPdf) {
      return NextResponse.json(
        { error: "Unsupported file type. Upload a JPEG, PNG, WEBP, or PDF." },
        { status: 400 }
      );
    }
    const ab = await file.arrayBuffer();
    // Persist the ORIGINAL upload to the vault; send a NORMALIZED copy to the
    // model. Phone/website screenshots are often tiny and low-contrast — without
    // upscaling+sharpening the reader mis-reads small print (wrong birth/entry
    // dates). PDFs are already high-resolution, so they pass through untouched.
    uploaded.push({ file, bytes: ab, mediaType: type });
    if (isPdf) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(ab).toString("base64") },
      });
    } else {
      let ocrData: Buffer;
      let ocrMedia: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      try {
        const norm = await normalizeImageForOcr(Buffer.from(ab));
        ocrData = norm.data;
        ocrMedia = norm.mediaType;
      } catch {
        ocrData = Buffer.from(ab); // best-effort: fall back to the raw upload
        ocrMedia = type as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      }
      content.push({
        type: "image",
        source: { type: "base64", media_type: ocrMedia, data: ocrData.toString("base64") },
      });
    }
  }
  content.push({ type: "text", text: EXTRACT_PROMPT });

  const claude = getClaudeClient();
  let rawText: string;
  try {
    const response = await claude.messages.create({
      model: SONNET,
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    });
    const first = response.content[0];
    rawText = first && first.type === "text" ? first.text : "";
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "We're a little busy right now. Please wait a moment and try again, or skip and answer the questions instead." },
        { status: 429 }
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: "We couldn't read your document right now. You can try again or skip and answer the questions." },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "Something went wrong reading your document. You can skip and answer the questions instead." },
      { status: 500 }
    );
  }

  const { documents_detected, fields: out, booleans, notes } = parseExtraction(rawText);

  // Persist the uploaded documents to the user's private vault so they appear in
  // "My Documents" AND so the form-filler can reuse the data we extracted (name,
  // country, dates). Best-effort: a storage/DB failure must NOT block onboarding.
  // Social Security cards are never stored. Low-confidence values are not carried
  // into the persisted fields — the user confirms those manually first.
  try {
    const flat: Record<string, string> = {};
    const trust = <T,>(f?: { value: T; confidence: string }) =>
      f && f.confidence !== "low" ? f.value : undefined;
    const fullName = trust(out.full_name);
    const country = trust(out.country_of_origin);
    const dob = trust(out.date_of_birth);
    const arrival = trust(out.arrival_date);
    const elig = trust(out.eligibility_date);
    const grant = trust(out.status_grant_date);
    const status = trust(out.immigration_status);
    const age = trust(out.age);
    if (fullName) flat.full_name = fullName;
    if (country) flat.country_of_origin = country;
    if (dob) flat.date_of_birth = dob;
    if (arrival) flat.arrival_date = arrival;
    if (elig) flat.eligibility_date = elig;
    if (grant) flat.status_grant_date = grant;
    if (status) flat.immigration_status = status;
    if (age != null) flat.age = String(age);
    const extractedFields = Object.keys(flat).length ? flat : null;

    const typeFor = (i: number): string => {
      switch (documents_detected[i] as DocType) {
        case "i94": return "i-94";
        case "ead": return "ead";
        case "asylum_letter": return "status_letter";
        case "green_card": return "green_card";
        default: return "other";
      }
    };

    for (let i = 0; i < uploaded.length; i++) {
      if (documents_detected[i] === "ssn_card") continue; // never store SSN cards
      const u = uploaded[i];
      const safeName = (u.file.name || `document-${i + 1}`).replace(/[^\w.\-]+/g, "_").slice(0, 80);
      const path = `${user.id}/onboarding-${Date.now()}-${i}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("user-documents")
        .upload(path, new Uint8Array(u.bytes), { contentType: u.mediaType, upsert: false });
      if (upErr) {
        console.error("[onboarding/extract] storage upload failed:", upErr.message);
        continue;
      }
      const { error: insErr } = await supabase.from("documents").insert({
        user_id: user.id,
        file_name: u.file.name || safeName,
        file_path: path,
        file_size: u.file.size,
        mime_type: u.mediaType,
        document_type: typeFor(i),
        extracted_fields: extractedFields,
      });
      if (insErr) console.error("[onboarding/extract] documents insert failed:", insErr.message);
    }
  } catch (e) {
    console.error("[onboarding/extract] vault persistence failed:", e);
  }

  return NextResponse.json({
    ok: true,
    documents_detected,
    fields: out,
    booleans,
    notes,
  });
}
