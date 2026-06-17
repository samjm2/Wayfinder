"use client";

// Client-side live language switching for the authenticated app.
//
// The dashboard server page seeds this provider with the user's language and the
// matching UIStrings (from getTranslations). setLanguage() then swaps the whole
// string set LIVE — fetching /api/translate for non-English, flipping the
// document lang/dir, persisting the choice (localStorage + profiles row), all
// without a full page reload. Mirrors the landing page's switch pattern.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import enStrings from "@/locales/en.json";
import type { UIStrings } from "@/lib/translations";
import { createClient } from "@/lib/supabase/client";

const EN = enStrings as UIStrings;

// Scripts that read right-to-left (mirrors the landing page's RTL set).
const RTL = new Set(["ar", "fa", "ps", "ur", "ku", "ckb"]);

export interface TranslationContextValue {
  t: UIStrings;
  lang: string;
  translating: boolean;
  isRtl: boolean;
  setLanguage: (code: string) => Promise<void>;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

export function useTranslation(): TranslationContextValue {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    throw new Error("useTranslation must be used inside a <TranslationProvider>");
  }
  return ctx;
}

export function TranslationProvider({
  initialLang,
  initialTranslations,
  children,
}: {
  initialLang: string;
  initialTranslations: UIStrings;
  children: ReactNode;
}) {
  const [lang, setLang] = useState(initialLang);
  const [t, setT] = useState<UIStrings>(initialTranslations ?? EN);
  const [translating, setTranslating] = useState(false);

  // Per-language cache + a guard so a slow earlier request can't clobber a newer
  // selection.
  const cacheRef = useRef<Record<string, UIStrings>>({
    en: EN,
    [initialLang]: initialTranslations ?? EN,
  });
  const latestRef = useRef(initialLang);

  const setLanguage = useCallback(async (code: string) => {
    setLang(code);
    latestRef.current = code;

    if (typeof document !== "undefined") {
      document.documentElement.lang = code;
      document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
    }
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem("wf_lang", code); } catch { /* ignore */ }
    }

    // Persist to the profile so the next server render is already in-language.
    // Fire-and-forget — a failure here must not block the UI switch.
    try {
      const sb = createClient();
      const { data: { user } } = await sb.auth.getUser();
      if (user) await sb.from("profiles").update({ language_code: code }).eq("id", user.id);
    } catch { /* ignore */ }

    if (code === "en") {
      setTranslating(false);
      if (latestRef.current === code) setT(EN);
      return;
    }

    const cached = cacheRef.current[code];
    if (cached) {
      setTranslating(false);
      if (latestRef.current === code) setT(cached);
      return;
    }

    setTranslating(true);
    try {
      const res = await fetch(`/api/translate?lang=${encodeURIComponent(code)}`);
      const data = await res.json();
      const next = data?.translations as UIStrings | undefined;
      if (res.ok && next) {
        cacheRef.current[code] = next;
        if (latestRef.current === code) setT(next);
      }
    } catch {
      /* keep current strings on failure */
    } finally {
      if (latestRef.current === code) setTranslating(false);
    }
  }, []);

  return (
    <TranslationContext.Provider
      value={{ t, lang, translating, isRtl: RTL.has(lang), setLanguage }}
    >
      {translating && (
        <div
          className="fixed left-1/2 top-4 z-[100] -translate-x-1/2"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2.5 rounded-full bg-text px-4 py-2 text-sm font-semibold text-on-primary shadow-md">
            <span
              aria-hidden="true"
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary"
            />
            {t.common.loading}
          </div>
        </div>
      )}
      {children}
    </TranslationContext.Provider>
  );
}
