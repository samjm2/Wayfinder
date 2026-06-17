"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("redirectTo") ?? "/dashboard";
  const redirectTo =
    raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")
      ? raw
      : "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      // Surface the actual reason instead of always blaming the password.
      // The most common case here is an account that exists but hasn't had its
      // email confirmed yet.
      if (/email not confirmed/i.test(signInError.message)) {
        setError(
          "Your account isn't confirmed yet. Check your email for the confirmation link, then sign in."
        );
      } else {
        setError("Incorrect email or password. Please try again.");
      }
      setLoading(false);
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6 py-12"
      style={{ background: "linear-gradient(180deg,#FBF6EE 0%,#F4ECDE 100%)" }}
    >
      <div className="mx-auto w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <Logo size={30} />
          <span className="text-xl font-extrabold tracking-[-0.02em] text-ink">Wayfinder</span>
        </Link>

        <div className="rounded-[22px] border border-border bg-surface p-8 shadow-md">
          <h1 className="font-display mb-2 text-2xl font-extrabold text-ink">Sign in</h1>
          <p className="mb-8 text-text-muted">Welcome back.</p>

          {error && (
            <div className="mb-6 rounded-xl bg-danger-50 px-4 py-3 text-sm font-medium text-danger-700 ring-1 ring-danger-100">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-semibold text-text">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full rounded-[13px] border border-border bg-surface px-4 py-3 text-lg text-text placeholder-text-faint transition focus:border-secondary focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-semibold text-text">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="w-full rounded-[13px] border border-border bg-surface px-4 py-3 text-lg text-text placeholder-text-faint transition focus:border-secondary focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-[14px] bg-primary py-4 text-lg font-bold text-on-primary shadow-sm transition hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            Don&apos;t have an account?{" "}
            <a href="/auth/signup" className="font-semibold text-link hover:underline">
              Create one — it&apos;s free
            </a>
          </p>
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-text-faint">
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          We never share your information with immigration enforcement.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
