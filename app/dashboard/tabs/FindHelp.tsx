"use client";

import { useState } from "react";
import providersData from "@/data/providers_directory.json";
import { useTranslation } from "@/components/i18n/TranslationProvider";

interface Props {
  state: string;
  zip: string;
}

interface Provider {
  name: string;
  type?: string;
  description?: string;
  website: string | null;
  phone: string | null;
  cities?: string[];
}

type DirectoryData = {
  national: { resources: Provider[] };
  [key: string]: { stateRefugeeOffice?: Provider; resettlementAgencies?: Provider[]; legalAid?: Provider[] } | { resources: Provider[] };
};

const directory = providersData as DirectoryData;

type Category = "all" | "refugee_office" | "resettlement" | "legal" | "national";

function MapPinIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block h-4 w-4 shrink-0"
    >
      <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block h-4 w-4 shrink-0"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block h-4 w-4 shrink-0"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ProviderCard({
  provider,
  callLabel,
  visitLabel,
}: {
  provider: Provider;
  callLabel: string;
  visitLabel: string;
}) {
  return (
    <div className="rounded-[--radius-lg] border border-border bg-surface p-5 shadow-sm transition-shadow hover:shadow-md">
      <h4 className="font-display text-lg font-bold text-text">{provider.name}</h4>
      {provider.description && <p className="mt-1 text-text-muted">{provider.description}</p>}
      {provider.cities && provider.cities.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-text-faint">
          <MapPinIcon />
          {provider.cities.join(", ")}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {provider.phone && (
          <a
            href={`tel:${provider.phone}`}
            role="button"
            aria-label={`${callLabel} ${provider.phone}`}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-4 py-2.5 text-sm font-semibold text-harbor-700 transition hover:border-harbor-500 hover:bg-harbor-50 active:scale-[0.98] focus-visible:outline-none"
          >
            <PhoneIcon /> {provider.phone}
          </a>
        )}
        {provider.website && (
          <a
            href={provider.website}
            target="_blank"
            rel="noopener noreferrer"
            role="button"
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[--radius-md] border-2 border-harbor-300 bg-surface px-4 py-2.5 text-sm font-semibold text-harbor-700 transition hover:border-harbor-500 hover:bg-harbor-50 active:scale-[0.98] focus-visible:outline-none"
          >
            {visitLabel} <ExternalLinkIcon />
          </a>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  emphasis,
  children,
}: {
  title: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h3
        className={`mb-4 flex items-center gap-2 font-display text-xl font-bold ${
          emphasis ? "text-review-700" : "text-text"
        }`}
      >
        {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export default function FindHelp({ state }: Props) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>("all");

  // Category filter labels. Reuse existing findHelp.* keys where available;
  // "all" has no dedicated key (GAP) so we fall back to common.* .
  const CATEGORIES: { value: Category; label: string }[] = [
    { value: "all", label: t.common.open },
    { value: "refugee_office", label: t.dashboard.findHelp.stateOffice },
    { value: "resettlement", label: t.dashboard.findHelp.resettlement },
    { value: "legal", label: t.dashboard.findHelp.legalAid },
    { value: "national", label: t.dashboard.findHelp.national },
  ];

  const callLabel = t.dashboard.findHelp.call;
  const visitLabel = t.dashboard.findHelp.visit;

  const stateData = state
    ? (directory[state] as
        | { stateRefugeeOffice?: Provider; resettlementAgencies?: Provider[]; legalAid?: Provider[] }
        | undefined)
    : undefined;
  const hasStateData = !!stateData;

  const show = (c: Category) => category === "all" || category === c;

  return (
    <div>
      <h2 className="mb-2 font-display text-2xl font-bold text-text md:text-3xl">
        {t.dashboard.findHelp.title}
      </h2>
      <p className="mb-6 text-lg text-text-muted">{t.dashboard.findHelp.subtitle}</p>

      {/* Category filter chips */}
      <div role="group" aria-label={t.dashboard.findHelp.title} className="mb-8 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => {
          const selected = category === c.value;
          return (
            <button
              key={c.value}
              onClick={() => setCategory(c.value)}
              aria-pressed={selected}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-bold transition active:scale-[0.98] focus-visible:outline-none ${
                selected
                  ? "bg-harbor-500 text-white"
                  : "bg-harbor-50 text-harbor-700 ring-1 ring-harbor-100 hover:bg-harbor-100"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {(show("legal") || category === "all") && (
        <div className="mb-8 rounded-[--radius-md] border border-review-100 bg-review-50 px-5 py-4 text-sm font-medium text-review-700">
          <p className="font-medium">{t.dashboard.findHelp.attorneyWarning}</p>
        </div>
      )}

      {!hasStateData && state && (
        <div className="mb-6 rounded-[--radius-md] bg-caution-50 px-4 py-3 text-sm text-caution-700 ring-1 ring-caution-100">
          {t.dashboard.findHelp.noState}
        </div>
      )}

      {show("refugee_office") && hasStateData && stateData.stateRefugeeOffice && (
        <Section title={t.dashboard.findHelp.stateOffice}>
          <ProviderCard provider={stateData.stateRefugeeOffice} callLabel={callLabel} visitLabel={visitLabel} />
        </Section>
      )}

      {show("resettlement") &&
        hasStateData &&
        stateData.resettlementAgencies &&
        stateData.resettlementAgencies.length > 0 && (
          <Section title={t.dashboard.findHelp.resettlement}>
            {stateData.resettlementAgencies.map((agency, i) => (
              <ProviderCard key={i} provider={agency} callLabel={callLabel} visitLabel={visitLabel} />
            ))}
          </Section>
        )}

      {show("legal") && hasStateData && stateData.legalAid && stateData.legalAid.length > 0 && (
        <Section title={t.dashboard.findHelp.legalAid} emphasis>
          {stateData.legalAid.map((org, i) => (
            <ProviderCard key={i} provider={org} callLabel={callLabel} visitLabel={visitLabel} />
          ))}
        </Section>
      )}

      {show("national") && (
        <Section title={t.dashboard.findHelp.national}>
          {directory.national.resources.map((resource, i) => (
            <ProviderCard key={i} provider={resource} callLabel={callLabel} visitLabel={visitLabel} />
          ))}
        </Section>
      )}
    </div>
  );
}
