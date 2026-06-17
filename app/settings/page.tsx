import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import type { Profile } from "@/lib/types";
import SettingsClient from "./SettingsClient";

// Protected like /dashboard. Loads the signed-in user's profile, seeds the live
// translation provider (per the i18n contract), then hands the profile to the
// settings client so the user can switch language live and edit their intake
// answers. Eligibility is NOT re-run here — the client re-runs it after a save.
export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login?redirectTo=/settings");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/onboarding");
  if (!profile.onboarding_complete) redirect("/onboarding");

  // Seed the live-translation provider with the user's language + strings.
  const language = profile.language_code ?? "en";
  let initialTranslations: UIStrings;
  try {
    initialTranslations = await getTranslations(language);
  } catch {
    initialTranslations = enStrings as UIStrings;
  }

  return (
    <TranslationProvider initialLang={language} initialTranslations={initialTranslations}>
      <SettingsClient profile={profile as Profile} />
    </TranslationProvider>
  );
}
