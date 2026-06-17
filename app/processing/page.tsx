"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const STEPS = [
  "Loading benefit rules",
  "Checking your eligibility",
  "Verifying results",
  "Ranking by deadline",
];

export default function ProcessingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stepIndex = 0;
    const interval = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, STEPS.length - 1);
      setCurrentStep(stepIndex);
    }, 8000);

    async function run() {
      try {
        const res = await fetch("/api/eligibility", { method: "POST" });
        const data = await res.json();
        clearInterval(interval);

        if (!res.ok || data.error) {
          setError(data.error ?? "Something went wrong. Please try again.");
          return;
        }

        setCurrentStep(STEPS.length - 1);
        setDone(true);

        setTimeout(() => {
          router.push("/dashboard");
        }, 2000);
      } catch {
        clearInterval(interval);
        setError("Something went wrong. Please try again.");
      }
    }

    run();
    return () => clearInterval(interval);
  }, [router]);

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6"
      style={{ background: "linear-gradient(180deg,#FBF6EE 0%,#F4ECDE 100%)" }}
    >
      <div className="mx-auto w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          {done ? (
            <svg aria-hidden="true" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-success-600">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="m9 11 3 3L22 4" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse text-secondary">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          )}
        </div>

        <h1 className="font-display mb-3 text-3xl font-extrabold text-ink">
          {done ? "Your plan is ready!" : "Finding your benefits..."}
        </h1>
        <p className="mb-12 text-text-muted">
          {done
            ? "We found benefits you may qualify for."
            : "We are reviewing your answers against official U.S. benefit programs. This usually takes about 30 seconds."}
        </p>

        {!done && !error && (
          <div className="mb-8 flex flex-col gap-3 text-left">
            {STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-3">
                <div
                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold transition-all ${
                    i < currentStep
                      ? "bg-success-600 text-white"
                      : i === currentStep
                      ? "bg-secondary text-white"
                      : "bg-sand-200 text-text-faint"
                  }`}
                >
                  {i < currentStep ? (
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={`text-base font-medium ${
                    i <= currentStep ? "text-text" : "text-text-faint"
                  }`}
                >
                  {step}
                </span>
                {i === currentStep && !done && (
                  <span className="ml-auto animate-pulse text-sm text-text-faint">Working...</span>
                )}
              </div>
            ))}
          </div>
        )}

        {done && (
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full rounded-[14px] bg-primary py-5 text-xl font-bold text-on-primary shadow-sm transition hover:bg-primary-hover"
          >
            See my plan →
          </button>
        )}

        {error && (
          <div className="rounded-xl bg-danger-50 px-4 py-4 text-left text-danger-700 ring-1 ring-danger-100">
            <p className="font-semibold">Something went wrong</p>
            <p className="mt-1 text-sm">{error}</p>
            <button
              onClick={() => router.push("/onboarding")}
              className="mt-4 rounded-xl bg-danger-100 px-4 py-2 text-sm font-semibold text-danger-700 hover:brightness-95"
            >
              Go back
            </button>
          </div>
        )}

        {!done && !error && (
          <p className="flex items-center justify-center gap-1.5 text-sm text-text-faint">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            We never share your information with immigration enforcement.
          </p>
        )}
      </div>
    </main>
  );
}
