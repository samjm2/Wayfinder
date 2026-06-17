"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { createClient } from "@/lib/supabase/client";

function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const lang = params.get("lang") ?? "en";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { language_code: lang },
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    // If email confirmation is required, signUp returns no session. Pushing to a
    // protected route here would just bounce the user to /auth/login (where they
    // can't sign in until they confirm), so tell them to check their email instead.
    if (!data.session) {
      setNeedsConfirmation(true);
      setLoading(false);
      return;
    }

    // Session exists — update profile with chosen language, then continue.
    await supabase.from("profiles").update({ language_code: lang }).eq("id", data.user!.id);

    router.push(`/onboarding?lang=${lang}`);
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

        {needsConfirmation ? (
          <div className="rounded-[22px] border border-border bg-surface p-8 text-center shadow-md">
            <div className="mb-4 flex justify-center">
              <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-secondary">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <h1 className="font-display mb-2 text-2xl font-extrabold text-ink">Check your email</h1>
            <p className="mb-6 text-text-muted">
              We sent a confirmation link to <span className="font-semibold text-text">{email}</span>.
              Click it to activate your account, then come back and sign in.
            </p>
            <a
              href={`/auth/login?lang=${lang}`}
              className="inline-block w-full rounded-[14px] bg-primary py-4 text-lg font-bold text-on-primary shadow-sm transition hover:bg-primary-hover"
            >
              Go to sign in
            </a>
          </div>
        ) : (
        <div className="rounded-[22px] border border-border bg-surface p-8 shadow-md">
          <h1 className="font-display mb-2 text-2xl font-extrabold text-ink">Create your account</h1>
          <p className="mb-8 text-text-muted">
            It&apos;s free. Your information stays private.
          </p>

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
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full rounded-[13px] border border-border bg-surface px-4 py-3 text-lg text-text placeholder-text-faint transition focus:border-secondary focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-[14px] bg-primary py-4 text-lg font-bold text-on-primary shadow-sm transition hover:bg-primary-hover disabled:opacity-60 focus-visible:outline-none"
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-text-muted">
            Already have an account?{" "}
            <a href={`/auth/login?lang=${lang}`} className="font-semibold text-link hover:underline">
              Sign in
            </a>
          </p>
        </div>
        )}

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

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
