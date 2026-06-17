import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "@/lib/translations";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

// Server-only: getTranslations reaches the service-role Supabase cache and the
// Claude (Sonnet) translator. Keep this off the Edge runtime so those server
// secrets never ship to the browser.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const lang = req.nextUrl.searchParams.get("lang") ?? "en";

  if (!SUPPORTED_LANGUAGES.some((l) => l.code === lang)) {
    return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
  }

  try {
    const translations = await getTranslations(lang);
    // Cache at the edge/CDN: a given language's UI strings are global, not
    // per-user, so they're safe to reuse across requests.
    return NextResponse.json(
      { translations },
      { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } }
    );
  } catch (err) {
    console.error("[/api/translate] failed for", lang, err);
    return NextResponse.json({ error: "Translation failed" }, { status: 500 });
  }
}
