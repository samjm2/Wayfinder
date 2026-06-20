import { createClient } from "@/lib/supabase/server";
import LandingClient from "./LandingClient";

// Server wrapper for the marketing landing page. It reads the auth state so the
// client view can route correctly:
//   • signed-OUT visitors  → "Get Started" creates an account, "Sign in" logs in.
//   • signed-IN visitors   → the CTA goes straight to /dashboard (which itself
//     bounces to /onboarding only when the profile is incomplete), and the
//     "Sign in" link is hidden. This prevents an already-authenticated user from
//     being dropped back into the sign-up / onboarding flow.
export default async function LandingPage() {
  let authed = false;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    authed = !!data.user;
  } catch {
    authed = false;
  }

  return <LandingClient authed={authed} />;
}
