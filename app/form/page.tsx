import { Suspense } from "react";
import { redirect } from "next/navigation";
import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import type { Profile } from "@/lib/types";
import FormFillClient from "./FormFillClient";

interface BenefitMeta {
  id: string;
  name: string;
  category: string;
  apply_link?: string;
  how_to_apply?: string;
  form?: { name?: string; url?: string; type?: string };
}

export interface FormMeta {
  benefitName?: string;
  needsAttorney: boolean;
  applyLink: string;
  howToApply?: string;
  // Trusted form info from benefits.json, threaded to the client so it knows
  // the official source and portal fallback link.
  form?: { name?: string; url?: string; type?: string };
}

function loadBenefits(): BenefitMeta[] {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "database", "benefits.json"), "utf8"));
  } catch {
    return [];
  }
}

export default async function FormPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
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

  // Load benefit metadata if a benefit ID is provided (server-side only).
  const params = await searchParams;
  const benefitId = params.benefit;
  let formMeta: FormMeta = { needsAttorney: false, applyLink: "" };
  if (benefitId) {
    const benefits = loadBenefits();
    const benefit = benefits.find((b) => b.id === benefitId);
    if (benefit) {
      formMeta = {
        benefitName: benefit.name,
        needsAttorney: benefit.category === "Legal / status",
        applyLink: benefit.apply_link ?? "",
        howToApply: benefit.how_to_apply,
        form: benefit.form,
      };
    }
  }

  return (
    <TranslationProvider initialLang={language} initialTranslations={initialTranslations}>
      {/* useSearchParams (in the client) requires a Suspense boundary in this
          Next version so the rest of the tree can still be prerendered. */}
      <Suspense fallback={null}>
        <FormFillClient profile={profile as Profile} formMeta={formMeta} />
      </Suspense>
    </TranslationProvider>
  );
}
