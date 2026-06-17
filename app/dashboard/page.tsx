import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import benefitsData from "@/database/benefits.json";
import DashboardClient from "./DashboardClient";

// Presentation-only map so the Action Plan can show "where & how to apply" and
// which form is needed. Pulled from the benefits database; the eligibility
// engine and benefits data themselves are NOT modified.
type FormInfo = { how_to_apply?: string; apply_link?: string; form?: { name?: string; url?: string; type?: string } };
function buildFormInfoById(): Record<string, FormInfo> {
  const out: Record<string, FormInfo> = {};
  for (const b of benefitsData as Array<{ id: string } & FormInfo>) {
    out[b.id] = { how_to_apply: b.how_to_apply, apply_link: b.apply_link, form: b.form };
  }
  return out;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login?redirectTo=/dashboard");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_complete) redirect("/onboarding");

  const { data: eligibilityResult } = await supabase
    .from("eligibility_results")
    .select("*")
    .eq("user_id", user.id)
    .order("generated_at", { ascending: false })
    .limit(1)
    .single();

  const { data: progressRows } = await supabase
    .from("benefit_progress")
    .select("*")
    .eq("user_id", user.id);

  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", user.id)
    .order("uploaded_at", { ascending: false });

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
      <DashboardClient
        profile={profile}
        eligibilityResult={eligibilityResult}
        progressRows={progressRows ?? []}
        documents={documents ?? []}
        formInfoById={buildFormInfoById()}
      />
    </TranslationProvider>
  );
}
