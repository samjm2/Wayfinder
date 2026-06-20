# Phase 2 — AI Portal Autofill (Chrome-extension agent)

> Status: **PROPOSED / NOT BUILT.** Approved direction: Chrome-extension agent
> architecture; up to **$0.30** of Anthropic API spend authorized for testing.
> Do not start the build until Phase 1 is verified.

## Why the extension (not the DevTools MCP)

A deployed web app cannot drive an arbitrary third-party portal (cross-origin
sandbox). The only production-viable way for Wayfinder to read/fill/click a live
government portal in the user's own logged-in session is the **paired Chrome
extension** (content scripts with host permissions). The bundled
`chrome-devtools-protocol-1.0.3.dxt` (a local Python CDP MCP) is a **developer/test
harness only** — it will be used to drive a local Chrome while building, never
shipped to end users.

## Current building blocks (already in the repo)

- `extension/src/background.ts` — paired via JWT, injects a one-shot `fillFields`
  content script into the active tab; redacts sensitive labels; shows a review
  banner. **Single-page, heuristic, no loop.**
- `app/api/extension/pair|exchange|profile-values` — pairing + non-sensitive
  profile value delivery.
- `lib/formFill.ts` — canonical field-name → profile-value mapping + sensitive
  detection (reuse this server-side and in the content script).
- `app/api/form-assist/route.ts` — existing Claude (Haiku) chat endpoint; the
  reasoning loop will follow its auth/scrub/typed-error pattern.

## Target architecture (the "agent loop")

```
Action Plan "Fill out with AI"
   → opens portal tab + Wayfinder side panel (progress feed)
   → loop, one page at a time:
        extension: SNAPSHOT page (fields, labels, buttons, errors, step markers)
           → POST /api/autofill/plan  (Claude reasons over snapshot + profile)
           ← PLAN: [{action: fill|select|click|ask_user|handoff_sensitive|review|done,
                     selector, value?, reason, confidence}]
        extension: execute non-sensitive, non-final actions; never click final submit
           → report results back to feed; re-snapshot; repeat
```

### The 8 per-page questions the planner must answer
What page am I on · what is it asking · which fields fill from profile · which need
clarification · which are sensitive · next safe action · did the page accept it · is
the next page the same flow.

## Hard safety rules (carry over from Phase 1 + existing code)
- **Never fill sensitive fields** (SSN, A-Number, USCIS#, passport, bank/routing,
  card, passwords, security answers, signatures, legal attestations). → pause +
  hand control to the user with a deep link to the exact page/field, then a
  **Resume AI** control.
- **Never click the final submit** without explicit user confirmation on a review
  screen.
- **Never fabricate** a value. Missing info → ask the user one clear question in
  the app, explain why, optionally save reusable answers to the profile, then
  continue.
- Reuse `isSensitiveName()` from `lib/formFill.ts` as the server-side gate too.

## New pieces to build
1. `app/api/autofill/plan/route.ts` — auth'd; takes a page snapshot + scrubbed
   profile; returns a validated action list. (Claude Haiku first; this is the only
   token cost — keep snapshots small, cap steps for the $0.30 test budget.)
2. Extension: snapshot serializer, action executor (fill/select/click/date/
   dropdown/checkbox), validation-error + step-change detection, sensitive +
   final-submit guards, message protocol with the app.
3. App side panel UX: real-time progress feed, missing-info prompt, sensitive
   handoff + Resume, review-before-submit, pause/cancel, resumable state across
   refresh.
4. Mock portal under `app/dev/mock-portal/*` (multi-step, a sensitive field, a
   validation error) to test end-to-end with **zero** third-party risk and minimal
   tokens.

## Test plan (within $0.30)
Drive the mock portal locally via the DevTools MCP: multi-step nav, one missing-info
prompt, one sensitive handoff + resume, one validation error, stop at the review
screen. Keep total planner calls in the low tens of Haiku requests.
