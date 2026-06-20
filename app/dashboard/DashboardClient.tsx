"use client";

import { Suspense, useCallback, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import type { Profile, EligibilityBenefit, BenefitProgress, Document } from "@/lib/types";
import ActionPlan from "./tabs/ActionPlan";
import DocumentsVault from "./tabs/DocumentsVault";
import FindHelp from "./tabs/FindHelp";
import ProgressTracker from "./tabs/ProgressTracker";
import SettingsClient from "../settings/SettingsClient";
import FormFillClient from "../form/FormFillClient";

interface Props {
  profile: Profile;
  eligibilityResult: {
    id: string;
    benefits: EligibilityBenefit[];
    summary: string;
    attorney_needed: boolean;
    rules_last_checked: string;
    flagged_for_human: { id: string; reason: string }[];
    language: string;
  } | null;
  progressRows: BenefitProgress[];
  documents: Document[];
  // Presentation-only "where & how to apply" + form info, keyed by benefit id.
  // Threaded through to the Action Plan.
  formInfoById?: Record<string, { how_to_apply?: string; apply_link?: string; form?: { name?: string; url?: string; type?: string } }>;
  // Which section to open first. Server-provided (e.g. /settings redirects here
  // with ?tab=settings) so there is no hydration flash.
  initialTab?: ViewId;
}

const TABS = [
  { id: "plan", labelKey: "actionPlan" },
  { id: "documents", labelKey: "documents" },
  { id: "form", labelKey: "formHelper" },
  { id: "help", labelKey: "findHelp" },
  { id: "progress", labelKey: "progress" },
] as const;

type TabId = typeof TABS[number]["id"];
// Settings is reachable from the same shell (the gear) but isn't a primary
// section, so it lives outside TABS while still being a selectable view.
export type ViewId = TabId | "settings";

// Inline stroke icons (Lucide-style), keyed by view. Decorative — the button
// carries the accessible label.
const ICONS: Record<ViewId | "signout", React.ReactNode> = {
  plan: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  documents: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  form: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
      <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
      <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
      <line x1="9.17" y1="14.83" x2="4.93" y2="19.07" />
    </>
  ),
  progress: (
    <>
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  signout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ),
};

const WELCOME_DISMISSED_KEY = "wf_welcome_dismissed";

// Subscribe to per-session dismissal stored in sessionStorage. Using
// useSyncExternalStore keeps the value SSR-safe (server snapshot is always
// "not dismissed", matching the rendered banner) and avoids setState-in-effect.
function subscribeDismissed(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
function getDismissedSnapshot() {
  try {
    return window.sessionStorage.getItem(WELCOME_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function getDismissedServerSnapshot() {
  return false;
}

export default function DashboardClient({
  profile,
  eligibilityResult,
  progressRows,
  documents,
  formInfoById,
  initialTab = "plan",
}: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewId>(initialTab);
  const [menuOpen, setMenuOpen] = useState(false);
  // Local immediate-dismiss flag (storage events don't fire in the same tab).
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const storedDismissed = useSyncExternalStore(
    subscribeDismissed,
    getDismissedSnapshot,
    getDismissedServerSnapshot
  );
  const welcomeDismissed = storedDismissed || locallyDismissed;

  const dismissWelcome = useCallback(() => {
    setLocallyDismissed(true);
    try {
      window.sessionStorage.setItem(WELCOME_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  const benefits: EligibilityBenefit[] = eligibilityResult?.benefits ?? [];
  const eligibleBenefits = benefits.filter(
    (b) => b.status === "likely_eligible"
  );

  const selectTab = (id: ViewId) => {
    setActiveTab(id);
    setMenuOpen(false);
  };

  // Icon nav button. Desktop = icon-only with an on-hover/-focus tooltip;
  // mobile = icon + label. The accessible name is always the label. Plain render
  // helper (not a component) so it can close over activeTab/selectTab.
  const renderNavButton = (opts: {
    id: ViewId;
    label: string;
    icon: React.ReactNode;
    mobile: boolean;
  }) => {
    const { id, label, icon, mobile } = opts;
    const isActive = activeTab === id;
    const tone = isActive
      ? "bg-sand-100 text-clay-700"
      : "text-text-muted hover:bg-sand-100 hover:text-text";
    if (mobile) {
      return (
        <button
          key={id}
          onClick={() => selectTab(id)}
          aria-current={isActive ? "page" : undefined}
          className={`inline-flex min-h-[44px] w-full items-center gap-3 rounded-[--radius-md] px-3.5 py-2.5 text-left text-sm font-semibold transition-colors focus-visible:outline-none ${tone}`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {icon}
          </svg>
          {label}
        </button>
      );
    }
    return (
      <button
        key={id}
        onClick={() => selectTab(id)}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        className={`group relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[--radius-md] px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:shadow-focus ${tone}`}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {icon}
        </svg>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-[#FBF6EE] opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {label}
        </span>
      </button>
    );
  };

  const renderSectionNav = (mobile: boolean) => (
    <>
      {TABS.map((tab) =>
        renderNavButton({
          id: tab.id,
          label: t.dashboard.tabs[tab.labelKey],
          icon: ICONS[tab.id],
          mobile,
        })
      )}
    </>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Navbar */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface shadow-sm">
        <div className="mx-auto max-w-5xl px-4 md:px-10">
          <div className="flex items-center justify-between gap-3 py-3">
            {/* Brand */}
            <Link href="/" className="flex shrink-0 items-center gap-2.5 focus-visible:outline-none">
              <Logo size={30} />
              <span className="font-display text-lg font-bold text-text">Wayfinder</span>
            </Link>

            {/* Inline section nav (desktop) */}
            <nav
              className="hidden flex-1 items-center justify-center gap-1 md:flex"
              aria-label={t.nav.dashboard}
            >
              {renderSectionNav(false)}
            </nav>

            {/* Right actions (desktop) */}
            <div className="ml-auto hidden shrink-0 items-center gap-1 md:flex">
              {renderNavButton({ id: "settings", label: t.nav.settings, icon: ICONS.settings, mobile: false })}
              <a
                href="/api/auth/signout"
                role="button"
                aria-label={t.nav.signOut}
                className="group relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[--radius-md] px-3 py-2.5 text-text-muted transition-colors hover:bg-sand-100 hover:text-text active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {ICONS.signout}
                </svg>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-[#FBF6EE] opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                >
                  {t.nav.signOut}
                </span>
              </a>
            </div>

            {/* Mobile menu toggle */}
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-controls="wf-mobile-menu"
              aria-label={t.nav.dashboard}
              title={t.nav.dashboard}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[--radius-md] text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none md:hidden"
            >
              {menuOpen ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              )}
            </button>
          </div>

          {/* Mobile menu */}
          {menuOpen && (
            <div id="wf-mobile-menu" className="border-t border-border py-2 md:hidden">
              <nav className="flex flex-col gap-1" aria-label={t.nav.dashboard}>
                {renderSectionNav(true)}
              </nav>
              <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                {renderNavButton({ id: "settings", label: t.nav.settings, icon: ICONS.settings, mobile: true })}
                <a
                  href="/api/auth/signout"
                  role="button"
                  className="inline-flex min-h-[44px] items-center gap-3 rounded-[--radius-md] px-3.5 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {ICONS.signout}
                  </svg>
                  {t.nav.signOut}
                </a>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Summary / welcome banner (dismissible per session) */}
      {eligibilityResult && !welcomeDismissed && activeTab !== "settings" && (
        <div className="border-b border-border bg-harbor-50 px-4 py-4 text-harbor-900 md:px-8">
          <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
            <div>
              <p className="text-base">{eligibilityResult.summary}</p>
              <p className="mt-1 text-xs text-text-faint">
                {eligibilityResult.rules_last_checked}
              </p>
            </div>
            <button
              type="button"
              onClick={dismissWelcome}
              aria-label={t.dashboard.dismiss}
              title={t.dashboard.dismiss}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-[--radius-md] text-harbor-900 transition hover:bg-harbor-100 focus-visible:outline-none"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Tab content */}
      <main className="flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">
          {activeTab === "plan" && (
            <ActionPlan
              benefits={eligibleBenefits}
              attorneyNeeded={eligibilityResult?.attorney_needed ?? false}
              rulesLastChecked={eligibilityResult?.rules_last_checked ?? ""}
              onSwitchTab={setActiveTab}
              formInfoById={formInfoById}
              userState={profile.state ?? undefined}
            />
          )}
          {activeTab === "documents" && (
            <DocumentsVault documents={documents} userId={profile.id} />
          )}
          {activeTab === "form" && (
            <Suspense fallback={null}>
              <FormFillClient profile={profile} />
            </Suspense>
          )}
          {activeTab === "help" && (
            <FindHelp state={profile.state ?? ""} zip={profile.zip_code ?? ""} />
          )}
          {activeTab === "progress" && (
            <ProgressTracker
              benefits={eligibleBenefits}
              progressRows={progressRows}
              userId={profile.id}
            />
          )}
          {activeTab === "settings" && (
            <SettingsClient profile={profile} documents={documents} embedded />
          )}
        </div>
      </main>

      <footer className="border-t border-border bg-surface px-6 py-4 text-center text-xs text-text-faint">
        {t.dashboard.footer.privacy} {t.dashboard.footer.disclaimer}
      </footer>
    </div>
  );
}
