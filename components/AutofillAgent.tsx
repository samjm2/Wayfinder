"use client";

// The user-facing "Fill Out Form with AI" experience. A side panel that drives
// the portal-automation agent and narrates it in real time:
//   • opens the benefits portal in a new tab (via the extension)
//   • snapshots each page, asks the planner for the next safe actions, executes
//     the safe ones, and shows a live feed
//   • pauses to ASK the user for missing info
//   • hands SENSITIVE fields to the user (highlights them in the portal) with a
//     Resume button
//   • stops at the review/submit step — it never submits an application
//
// All control stays with the user: pause/cancel anytime, and nothing sensitive
// is ever typed or submitted by the agent.

import { useCallback, useEffect, useRef, useState } from "react";
import { agent, detectExtension, type ExecAction } from "@/lib/autofill/agentClient";
import type { Plan, PlanAction, PageSnapshot } from "@/lib/autofill/plan";

type Phase = "checking" | "no_extension" | "ready" | "running" | "ask" | "handoff" | "login" | "review" | "done" | "error";
type Tone = "info" | "ok" | "warn" | "danger";
interface FeedItem { id: number; tone: Tone; text: string }

const MAX_ROUNDS = 16;

const TONE_DOT: Record<Tone, string> = {
  info: "bg-harbor-400",
  ok: "bg-success-600",
  warn: "bg-review-600",
  danger: "bg-danger-600",
};

// A STRUCTURAL signature of the page (url + headings + field identities +
// button labels) — deliberately excludes field values, so we can tell a real
// step change from "same page, we just typed into it."
function structSig(s: PageSnapshot): string {
  return JSON.stringify([
    s.url,
    s.headings,
    s.fields.map((f) => [f.ref, f.type, f.label]),
    s.buttons.map((b) => b.text),
  ]);
}

export default function AutofillAgent({
  benefitName,
  portalUrl,
  onClose,
}: {
  benefitName: string;
  portalUrl: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [ask, setAsk] = useState<{ field: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [handoff, setHandoff] = useState<{ label: string; reason: string } | null>(null);
  const [error, setError] = useState("");

  const askedRef = useRef<string[]>([]);
  const answersRef = useRef<Record<string, string>>({});
  const roundsRef = useRef(0);
  const lastSigRef = useRef("");
  const lastFilledRef = useRef(0);
  const stuckRef = useRef(0);
  const cancelRef = useRef(false);
  const feedIdRef = useRef(0);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  // Holds the latest advance() so the loop can re-invoke itself after a
  // navigation without a useCallback self-reference (disallowed by the linter).
  const advanceRef = useRef<() => void>(() => {});

  const log = useCallback((tone: Tone, text: string) => {
    setFeed((f) => [...f, { id: ++feedIdRef.current, tone, text }]);
  }, []);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed, phase]);

  useEffect(() => {
    let alive = true;
    detectExtension().then((present) => {
      if (alive) setPhase(present ? "ready" : "no_extension");
    });
    return () => {
      alive = false;
      cancelRef.current = true;
      void agent.close().catch(() => {});
    };
  }, []);

  async function getPlan(snapshot: PageSnapshot): Promise<Plan> {
    const res = await fetch("/api/autofill/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, asked: askedRef.current, answers: answersRef.current }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Couldn't plan the next step.");
    return data.plan as Plan;
  }

  // One round: read the page, plan, act, then either continue, pause, or finish.
  const advance = useCallback(async () => {
    if (cancelRef.current) return;
    if (roundsRef.current >= MAX_ROUNDS) {
      setPhase("done");
      log("info", "Reached the step limit for one session — you can take it from here.");
      return;
    }
    roundsRef.current += 1;
    setPhase("running");
    try {
      log("info", "Reading the current page…");
      const snap = await agent.snapshot();
      // Progress = the page structure changed (new step) OR we filled a new
      // field. If neither happens across rounds, we're stuck (e.g. clicking a
      // link on an info page that never becomes a form).
      const sig = structSig(snap);
      const filled = snap.fields.filter((f) => f.value && f.value !== "").length;
      const progressed = sig !== lastSigRef.current || filled > lastFilledRef.current;
      stuckRef.current = progressed ? 0 : stuckRef.current + 1;
      lastSigRef.current = sig;
      lastFilledRef.current = filled;

      if (snap.headings[0]) log("info", `On: ${snap.headings[0]}${snap.step ? ` (${snap.step})` : ""}`);
      log("info", `Found ${snap.fields.length} field${snap.fields.length === 1 ? "" : "s"} on this step.`);

      const plan = await getPlan(snap);
      if (plan.summary) log("info", plan.summary);

      // Login wall → hand control to the user to sign in. We never fill or store
      // a password; the user signs in themselves, then resumes. We trust the
      // planner's classification: a page that merely *contains* a sign-in box but
      // also offers a guest/apply path is NOT a login wall (pageType stays
      // application_step), so the agent takes the guest path instead.
      if (plan.pageType === "login") {
        await agent.focusPortal().catch(() => {});
        log("warn", "This is a sign-in page. Please log in yourself in the portal tab — Wayfinder never sees or stores your password.");
        setPhase("login");
        return;
      }

      // No-progress guard: same structure, nothing newly filled, across rounds →
      // stop instead of looping. Almost always an info/navigation page, a login
      // wall, or a dead end — not a fillable application.
      if (stuckRef.current >= 2) {
        await agent.focusPortal().catch(() => {});
        setPhase("done");
        log("warn", "I can't make progress on this page — it looks like an information or navigation page (or a login wall), not a fillable application form. Open the actual application form, sign in first if needed, and run me again — or fill it out by hand.");
        return;
      }

      const actions = plan.actions;
      const fills = actions.filter(
        (a): a is Extract<PlanAction, { action: "fill" | "select" | "check" }> =>
          a.action === "fill" || a.action === "select" || a.action === "check",
      );
      const asks = actions.filter((a): a is Extract<PlanAction, { action: "ask_user" }> => a.action === "ask_user");
      const handoffs = actions.filter((a): a is Extract<PlanAction, { action: "handoff_sensitive" }> => a.action === "handoff_sensitive");
      const click = actions.find((a): a is Extract<PlanAction, { action: "click" }> => a.action === "click");
      const review = actions.find((a) => a.action === "review");
      const done = actions.find((a) => a.action === "done");

      // 1) Execute the safe fills.
      if (fills.length) {
        const exec: ExecAction[] = fills.map((a) =>
          a.action === "check"
            ? { action: "check", ref: a.ref, value: a.value }
            : { action: a.action, ref: a.ref, value: a.value },
        );
        const results = await agent.execute(exec);
        fills.forEach((a, i) => {
          const r = results[i];
          if (r?.ok) log("ok", `Filled ${a.label}.`);
          else log("warn", `Couldn't fill ${a.label}${r?.note ? ` (${r.note})` : ""}.`);
        });
      }

      // 2) Review/submit page → highlight sensitive fields, stop (never submit).
      if (review) {
        for (const h of handoffs) await agent.highlight(h.ref).catch(() => {});
        await agent.focusPortal().catch(() => {});
        log("warn", "Review step reached. Please review everything and submit it yourself.");
        setPhase("review");
        return;
      }

      // If the page never changed since the last round AND all the agent can do
      // is ask/hand off again, we're stuck — almost always because this isn't an
      // actual application form (an info/landing page, a login wall, etc.). Stop
      // instead of looping the same question forever.
      const onlyNeedsUser = !fills.length && !click && (asks.length > 0 || handoffs.length > 0);
      if (stuckRef.current >= 1 && onlyNeedsUser) {
        await agent.focusPortal().catch(() => {});
        setPhase("done");
        log("warn", "This page doesn't look like an application form I can fill — it may be an information, sign-up, or login page rather than the actual benefit application. Open the real application form (or sign in first), then run me again. You can also fill it out by hand.");
        return;
      }

      // 3) Missing info → ask the user (one question; we re-plan after the answer).
      if (asks.length) {
        await agent.focusPortal().catch(() => {});
        const a = asks[0];
        log("warn", `Need your input: ${a.question}`);
        setAsk({ field: a.field, question: a.question });
        setPhase("ask");
        return;
      }

      // 4) Sensitive field mid-form → hand control to the user.
      if (handoffs.length) {
        const h = handoffs[0];
        await agent.highlight(h.ref).catch(() => {});
        await agent.focusPortal().catch(() => {});
        log("warn", `${h.label} is sensitive — please enter it yourself in the portal.`);
        setHandoff({ label: h.label, reason: h.reason });
        setPhase("handoff");
        return;
      }

      // 5) Advance to the next step.
      if (click) {
        log("info", `Continuing to the next step (${click.label})…`);
        await agent.execute([{ action: "click", ref: click.ref }]);
        setTimeout(() => advanceRef.current(), 1300); // let the page navigate
        return;
      }

      // 6) Done, or stuck with nothing left to do.
      if (done || stuckRef.current >= 1) {
        setPhase("done");
        log("ok", done ? "All done on this application." : "Nothing left to fill automatically — over to you.");
        return;
      }

      // Only fills happened and the page changed — look again.
      setTimeout(() => advanceRef.current(), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [log]);

  // Keep the ref pointing at the current advance() for the recursive timeouts.
  useEffect(() => { advanceRef.current = () => { void advance(); }; }, [advance]);

  async function start() {
    setFeed([]);
    askedRef.current = [];
    answersRef.current = {};
    roundsRef.current = 0;
    lastSigRef.current = "";
    stuckRef.current = 0;
    cancelRef.current = false;
    setPhase("running");
    try {
      log("info", "Opening the benefits portal…");
      await agent.openPortal(portalUrl);
      await advance();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the portal.");
      setPhase("error");
    }
  }

  function submitAnswer() {
    if (!ask) return;
    const v = answer.trim();
    if (!v) return;
    answersRef.current[ask.field] = v;
    if (!askedRef.current.includes(ask.field)) askedRef.current.push(ask.field);
    log("ok", `You answered: ${v}`);
    setAsk(null);
    setAnswer("");
    void advance();
  }

  function resumeFromHandoff() {
    setHandoff(null);
    log("info", "Thanks — continuing.");
    void advance();
  }

  function cancel() {
    cancelRef.current = true;
    void agent.close().catch(() => {});
    onClose();
  }

  const busy = phase === "running";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="AI application assistant">
      <button aria-hidden="true" tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={cancel} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border bg-harbor-50 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-text">Fill out with AI</h2>
            <p className="text-sm text-text-muted">{benefitName}</p>
          </div>
          <button onClick={cancel} aria-label="Close" className="rounded-md p-1.5 text-text-muted hover:bg-harbor-100 hover:text-text focus-visible:outline-none">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {phase === "checking" && <p className="text-sm text-text-muted">Checking for the Wayfinder browser extension…</p>}

          {phase === "no_extension" && (
            <div className="rounded-[--radius-md] border border-review-100 bg-review-50 px-4 py-3 text-sm text-review-700">
              <p className="font-semibold">Can&apos;t reach the Wayfinder extension on this page.</p>
              <p className="mt-1">
                <strong>If you just installed or reloaded the extension, refresh this page</strong> (⌘R / Ctrl-R) and try again — reloading the extension disconnects it from open tabs until they reload.
              </p>
              <p className="mt-2">
                If it&apos;s not connected yet, open <strong>Settings → Auto-fill</strong> to connect it. The extension lets Wayfinder read and fill the portal page in your browser — your data never leaves your machine except the non-sensitive facts needed to fill a field.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="mt-3 rounded-[--radius-md] bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover"
              >
                Refresh this page
              </button>
            </div>
          )}

          {phase !== "checking" && phase !== "no_extension" && (
            <>
              {feed.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Wayfinder will open the application portal, fill what it can from your profile, ask you about anything it doesn&apos;t know, and pause for anything sensitive. It never submits — you always do that yourself.
                </p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {feed.map((it) => (
                    <li key={it.id} className="flex items-start gap-2.5 text-sm text-text">
                      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${TONE_DOT[it.tone]}`} aria-hidden="true" />
                      <span>{it.text}</span>
                    </li>
                  ))}
                  {busy && (
                    <li className="flex items-center gap-2.5 text-sm text-text-muted">
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-harbor-200 border-t-harbor-500" aria-hidden="true" />
                      Working…
                    </li>
                  )}
                  <div ref={feedEndRef} />
                </ul>
              )}

              {/* Ask the user for missing info */}
              {phase === "ask" && ask && (
                <div className="mt-4 rounded-[--radius-md] border border-harbor-200 bg-harbor-50 p-4">
                  <p className="mb-2 text-sm font-semibold text-text">{ask.question}</p>
                  <input
                    autoFocus
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitAnswer(); }}
                    placeholder="Type your answer"
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-3 py-2 text-base text-text focus:border-harbor-400 focus:outline-none"
                  />
                  <button onClick={submitAnswer} disabled={!answer.trim()} className="mt-3 w-full rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-40">
                    Send &amp; continue
                  </button>
                </div>
              )}

              {/* Sensitive handoff */}
              {phase === "handoff" && handoff && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-review-100 bg-review-50 p-4">
                  <p className="text-sm font-semibold text-review-700">This field is sensitive: {handoff.label}</p>
                  <p className="mt-1 text-sm text-review-700">{handoff.reason} We&apos;ve highlighted it in the portal tab. Please enter it there yourself, then resume.</p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-review-100 bg-surface py-2.5 text-sm font-semibold text-review-700 hover:bg-review-50">
                      Open the portal
                    </button>
                    <button onClick={resumeFromHandoff} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      I&apos;ve done it — Resume
                    </button>
                  </div>
                </div>
              )}

              {/* Login wall hand-off */}
              {phase === "login" && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-harbor-200 bg-harbor-50 p-4">
                  <p className="text-sm font-semibold text-text">Please sign in to continue</p>
                  <p className="mt-1 text-sm text-text-muted">
                    This site needs you to log in first. Sign in yourself in the portal tab — <strong>Wayfinder never sees or stores your password.</strong> Once you&apos;re signed in and on the application form, click Resume and I&apos;ll fill it in.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-harbor-300 bg-surface py-2.5 text-sm font-semibold text-harbor-700 hover:bg-harbor-50">
                      Open the portal
                    </button>
                    <button onClick={resumeFromHandoff} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      I&apos;m signed in — Resume
                    </button>
                  </div>
                </div>
              )}

              {/* Review gate */}
              {phase === "review" && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-success-100 bg-success-50 p-4">
                  <p className="text-sm font-semibold text-success-700">Review &amp; submit — it&apos;s your turn.</p>
                  <p className="mt-1 text-sm text-success-700">Wayfinder filled what it safely could and stopped before submitting. Open the portal, review every field, complete any sensitive ones, and submit when you&apos;re ready.</p>
                  <button onClick={() => agent.focusPortal()} className="mt-3 w-full rounded-[--radius-md] bg-success-600 py-2.5 text-sm font-semibold text-white hover:bg-success-700">
                    Open the portal to review
                  </button>
                </div>
              )}

              {phase === "done" && (
                <div className="mt-4 rounded-[--radius-md] border border-success-100 bg-success-50 px-4 py-3 text-sm text-success-700">
                  Finished what could be filled automatically. Review and submit on the portal yourself.
                </div>
              )}

              {phase === "error" && (
                <div className="mt-4 rounded-[--radius-md] border border-danger-100 bg-danger-50 px-4 py-3 text-sm text-danger-700">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer / controls */}
        <div className="border-t border-border px-5 py-4">
          {phase === "ready" && (
            <button onClick={start} className="w-full rounded-[--radius-md] bg-primary py-3 text-base font-semibold text-on-primary shadow-sm hover:bg-primary-hover">
              Start filling {benefitName}
            </button>
          )}
          {(phase === "error" || phase === "done") && (
            <button onClick={start} className="w-full rounded-[--radius-md] border-2 border-harbor-300 bg-surface py-3 text-base font-semibold text-harbor-700 hover:bg-harbor-50">
              {phase === "error" ? "Try again" : "Run again"}
            </button>
          )}
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-text-faint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            Wayfinder never enters sensitive info or submits for you.
          </p>
        </div>
      </div>
    </div>
  );
}
