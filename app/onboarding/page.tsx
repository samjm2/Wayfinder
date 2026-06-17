import { Suspense } from "react";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import OnboardingForm from "./OnboardingForm";

// Server wrapper for the intake flow. Reads the initial language from the
// ?lang= search param (else "en"), seeds the live-translation provider with the
// matching UIStrings (per the i18n contract), then renders the client intake
// form. The provider's setLanguage() lets the language step re-translate the
// whole onboarding UI live.
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawLang = sp.lang;
  const langCode = (Array.isArray(rawLang) ? rawLang[0] : rawLang) ?? "en";

  let initialTranslations: UIStrings;
  try {
    initialTranslations = await getTranslations(langCode);
  } catch {
    initialTranslations = enStrings as UIStrings;
  }

  return (
    <TranslationProvider initialLang={langCode} initialTranslations={initialTranslations}>
      <Suspense>
        <OnboardingForm />
      </Suspense>
    </TranslationProvider>
  );
}
