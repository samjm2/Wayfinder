import { redirect } from "next/navigation";

// Settings now lives INSIDE the dashboard shell as a tab, so it shares the same
// navbar/footer as the rest of the app instead of being a disconnected page.
// Any direct visit to /settings (old links, bookmarks) is forwarded to the
// dashboard with the Settings tab pre-selected. The dashboard route performs the
// auth + onboarding-complete checks.
export default function SettingsPage() {
  redirect("/dashboard?tab=settings");
}
