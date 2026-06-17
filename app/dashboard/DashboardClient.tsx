"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Logo from "@/components/Logo";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import type { Profile, EligibilityBenefit, BenefitProgress, Document } from "@/lib/types";
import ActionPlan from "./tabs/ActionPlan";
import DocumentsVault from "./tabs/DocumentsVault";
import FormAssistant from "./tabs/FormAssistant";
import FindHelp from "./tabs/FindHelp";
import ProgressTracker from "./tabs/ProgressTracker";

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
}

const TABS = [
  { id: "plan", labelKey: "actionPlan" },
  { id: "documents", labelKey: "documents" },
  { id: "form", labelKey: "formHelper" },
  { id: "help", labelKey: "findHelp" },
  { id: "progress", labelKey: "progress" },
] as const;

type TabId = typeof TABS[number]["id"];

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
}: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("plan");
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

  const selectTab = (id: TabId) => {
    setActiveTab(id);
    setMenuOpen(false);
  };

  const navItems = (
    <>
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const label = t.dashboard.tabs[tab.labelKey];
        return (
          <button
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex min-h-[44px] w-full items-center rounded-[--radius-md] px-3.5 py-2.5 text-left text-sm font-semibold transition-colors focus-visible:outline-none md:w-auto md:text-center ${
              isActive
                ? "bg-sand-100 text-clay-700"
                : "text-text-muted hover:bg-sand-100 hover:text-text"
            }`}
          >
            {label}
          </button>
        );
      })}
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
              {navItems}
            </nav>

            {/* Right actions (desktop) */}
            <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">
              <Link
                href="/settings"
                className="inline-flex min-h-[44px] items-center justify-center rounded-[--radius-md] px-3.5 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
              >
                {t.nav.settings}
              </Link>
              <a
                href="/api/auth/signout"
                role="button"
                className="inline-flex min-h-[44px] items-center justify-center rounded-[--radius-md] px-3.5 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text active:scale-[0.98] focus-visible:outline-none"
              >
                {t.nav.signOut}
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
                {navItems}
              </nav>
              <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="inline-flex min-h-[44px] items-center rounded-[--radius-md] px-3.5 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
                >
                  {t.nav.settings}
                </Link>
                <a
                  href="/api/auth/signout"
                  role="button"
                  className="inline-flex min-h-[44px] items-center rounded-[--radius-md] px-3.5 py-2.5 text-sm font-semibold text-text-muted transition hover:bg-sand-100 hover:text-text focus-visible:outline-none"
                >
                  {t.nav.signOut}
                </a>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Summary / welcome banner (dismissible per session) */}
      {eligibilityResult && !welcomeDismissed && (
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
            />
          )}
          {activeTab === "documents" && (
            <DocumentsVault documents={documents} userId={profile.id} />
          )}
          {activeTab === "form" && (
            <FormAssistant
              language={profile.language_code}
              profile={profile}
              documents={documents}
              benefits={eligibleBenefits}
              formInfoById={formInfoById}
            />
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
        </div>
      </main>

      <footer className="border-t border-border bg-surface px-6 py-4 text-center text-xs text-text-faint">
        {t.dashboard.footer.privacy} {t.dashboard.footer.disclaimer}
      </footer>
    </div>
  );
}
