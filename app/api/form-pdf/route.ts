// Server-side proxy that serves the REAL official benefit form.
//
// Why this exists: official PDFs live on government origins that do not send
// CORS headers, so the browser cannot fetch them directly. This Node route
// fetches the bytes server-side and streams them back same-origin.
//
// SSRF safety: we NEVER fetch an arbitrary client-supplied URL. The client only
// passes a benefit id; we look that id up in database/benefits.json and fetch
// only the URL that the trusted data file declares for that benefit. We also
// require https.
//
// Response contract:
//   - real fillable PDF available  -> 200 application/pdf (the bytes)
//   - applied for via a portal/site -> 200 { portal: true, applyLink }
//   - fetch failed / not a PDF      -> 502 { error }

import { readFileSync } from "fs";
import { join } from "path";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BenefitForm {
  name?: string;
  url?: string;
  type?: string;
}

interface BenefitRecord {
  id: string;
  apply_link?: string;
  form?: BenefitForm;
}

function loadBenefits(): BenefitRecord[] {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "database", "benefits.json"), "utf8"),
    );
  } catch {
    return [];
  }
}

// Curated, VERIFIED official fillable-PDF URLs for benefits whose benefits.json
// "form.url" points at an HTML landing page rather than the PDF itself. Each URL
// was confirmed to return real %PDF bytes. These are trusted (hard-coded here),
// so fetching them is SSRF-safe.
const OFFICIAL_FORM_PDFS: Record<string, string> = {
  adjustment_of_status: "https://www.uscis.gov/sites/default/files/document/forms/i-485.pdf",
  ssdi: "https://www.ssa.gov/forms/ssa-16.pdf",
  ssi: "https://www.ssa.gov/forms/ssa-8000-bk.pdf",
};

// A benefit has a real downloadable PDF when its form url is a .pdf, or its
// form type marks it as an official/fillable federal PDF.
function looksLikeRealPdf(form: BenefitForm | undefined): boolean {
  if (!form) return false;
  const url = form.url ?? "";
  if (/\.pdf(\?|#|$)/i.test(url)) return true;
  const type = (form.type ?? "").toLowerCase();
  return type === "federal_pdf" || type.includes("fillable") || type.includes("pdf");
}

export async function GET(request: NextRequest) {
  const benefitId = request.nextUrl.searchParams.get("benefit");
  if (!benefitId) {
    return Response.json({ error: "missing benefit id" }, { status: 400 });
  }

  const benefit = loadBenefits().find((b) => b.id === benefitId);
  if (!benefit) {
    return Response.json({ error: "unknown benefit" }, { status: 404 });
  }

  const form = benefit.form;
  const applyLink = benefit.apply_link || form?.url || "";

  // Pick the real fillable PDF: prefer the verified curated map, else a
  // benefits.json form url that is itself a .pdf. Anything else -> portal.
  const target =
    OFFICIAL_FORM_PDFS[benefitId] ??
    (looksLikeRealPdf(form) && /\.pdf(\?|#|$)/i.test(form?.url ?? "") ? (form?.url ?? "") : "");

  if (!target) {
    return Response.json({ portal: true, applyLink }, { status: 200 });
  }

  // We only ever fetch a trusted URL (curated map or the data file), https only.
  // On ANY failure we fall back to the portal panel (the official apply link) —
  // never to a generic sample form.
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ portal: true, applyLink }, { status: 200 });
  }
  if (parsed.protocol !== "https:") {
    return Response.json({ portal: true, applyLink }, { status: 200 });
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      redirect: "follow",
      headers: { Accept: "application/pdf,*/*" },
    });
    if (!upstream.ok) {
      return Response.json({ portal: true, applyLink }, { status: 200 });
    }

    const buf = new Uint8Array(await upstream.arrayBuffer());
    // Verify genuine PDF ("%PDF" magic bytes); landing pages are HTML.
    const isPdf =
      buf.length >= 4 &&
      buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
    if (!isPdf) {
      return Response.json({ portal: true, applyLink }, { status: 200 });
    }

    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ portal: true, applyLink }, { status: 200 });
  }
}
