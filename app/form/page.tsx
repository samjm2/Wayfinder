import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import type { Profile } from "@/lib/types";
import FormFillClient from "./FormFillClient";

// Custom PDF form-fill page.
//
// Reached two ways (both already wired in the dashboard):
//   /form?src=<id>            — a PDF the user uploaded in the Form Assistant,
//                               held IN MEMORY via the client-side formFileStore
//                               (object URL); never uploaded to a server.
//   /form?benefit=&form=      — an action item asked for help with a benefit's
//                               form; we fall back to a bundled sample PDF so the
//                               demo always has a real fillable form to show.
//
// Mirrors the settings server wrapper: protect the route, load the signed-in
// user's profile, seed the live-translation provider with their language, then
// hand the (privacy-scrubbed) profile to the client. The actual PDF rendering,
// field reading, auto-fill and download all happen IN THE BROWSER — the profile
// is the only data crossing into the client, and sensitive numbers are never
// auto-filled (see FormFillClient).
export default async function FormPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login?redirectTo=/dashboard");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/onboarding");
  if (!profile.onboarding_complete) redirect("/onboarding");

  const language = profile.language_code ?? "en";
  let initialTranslations: UIStrings;
  try {
    initialTranslations = await getTranslations(language);
  } catch {
    initialTranslations = enStrings as UIStrings;
  }

  return (
    <TranslationProvider initialLang={language} initialTranslations={initialTranslations}>
      {/* useSearchParams (in the client) requires a Suspense boundary in this
          Next version so the rest of the tree can still be prerendered. */}
      <Suspense fallback={null}>
        <FormFillClient profile={profile as Profile} />
      </Suspense>
    </TranslationProvider>
  );
}
