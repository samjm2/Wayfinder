# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint (flat config in `eslint.config.mjs`, `eslint-config-next`)

There is **no test runner configured** (no test script, no test files). Verify changes via `npm run build` + `npm run lint` and by exercising flows in the running app.

## Environment

Required env vars (in `.env.local`):
- `ANTHROPIC_API_KEY` — Claude API
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase client/auth
- `SUPABASE_SERVICE_ROLE_KEY` — server-only privileged writes (eligibility results, translation cache)

## Next.js 16 — read before coding

This is **Next.js 16.2.9 + React 19**, which differs from older Next.js. AGENTS.md mandates reading `node_modules/next/dist/docs/` before writing Next.js code. The most load-bearing breaking change here:

- **Middleware is `proxy.ts` at the repo root** (not `middleware.ts`). It runs `@supabase/ssr` `supabase.auth.getUser()` on every request, protects `/dashboard`, `/onboarding`, `/processing`, and bounces authed users away from `/auth/*`.

## Architecture

A multilingual web app ("Wayfinder") that tells refugees/immigrants which U.S. federal benefits they likely qualify for, with deadlines, required docs, and next steps. Stack: Next.js App Router, Supabase (auth + Postgres + Storage), Claude (`@anthropic-ai/sdk`).

**User flow:** signup/login (`app/auth/*`) → `app/onboarding` multi-step wizard writes the `profiles` row → `app/processing` triggers `POST /api/eligibility` → `app/dashboard` (server component fetches data; renders `DashboardClient.tsx` with tabs: action plan, documents, form assistant, explain-a-letter, find-help, progress).

### Server/client boundaries (important)
- `lib/claude.ts` and the service-role Supabase client are **server-only**. `next.config.ts` lists `@anthropic-ai/sdk` under `serverExternalPackages`. Never import these from client components or expose the API/service keys to the browser.
- Supabase: `lib/supabase/server.ts` exports `createClient()` (anon, respects user cookies) and `createServiceClient()` (service role, privileged writes); `lib/supabase/client.ts` is the browser client.
- Model constants live in `lib/claude.ts`: `OPUS = "claude-opus-4-8"`, `SONNET = "claude-sonnet-4-6"`.

### Eligibility engine — `app/api/eligibility/route.ts`
This is the heart of the app, and its behavior is subtle:
1. **Derived fields are computed deterministically in TypeScript** (`computeDerived`): ORR-eligible / qualified-alien / LPR status, months/years since key dates, `percent_fpl` from `data/fpl_2025.json`, and pre-gated `eligible_for_tanf/ssi/medicaid` (RCA/RMA/Matching-Grant rules depend on these).
2. **Rule *application* is then delegated to Claude Opus**, not evaluated in code. The profile + derived fields + the full `database/benefits.json` (25 programs, each with a structured `{all,any,not,var,is,lte,gte,fpl}` `rule`) are sent to Opus, which returns per-benefit statuses (`likely_eligible | maybe_eligible | not_eligible | needs_human_review`).
3. A **second Opus "verification pass"** re-checks; on any disagreement for a non-`not_eligible` benefit, the merge downgrades it to `needs_human_review`.
4. A third short Opus call writes a warm summary **in the user's language**. Results are ranked (soonest deadline first) and saved to `eligibility_results` via the service client.

> Note: `database/README.md` states eligibility is "decided by rules, not AI." That describes the database's design intent. The current **implementation** delegates rule application to Claude (with a verification pass), while only the derived inputs are deterministic. Keep both in mind when changing this path.

### Data / rules (`data/` and `database/`)
- `database/benefits.json` (+ `.js`) — 25 federal programs with machine-evaluable `rule` trees, deadlines, required docs, `restore_if_lost` paths, and `sources` with `asOf` dates. `database/eligibility-schema.js` documents the 31 variables and the rule operators.
- `data/fpl_2025.json` — HHS Federal Poverty Level table (drives `fpl` rule checks; update annually).
- `data/providers_directory.json` — state-keyed resettlement/legal-aid resources for the "Find Help" tab.
- Rules encode time-sensitive 2025–2026 policy (OBBBA SNAP/Medicaid/ACA cliffs, RCA/RMA 4-month window). Re-verify against `sources` before each program year.

### Internationalization (`locales/`, `lib/translations.ts`, `lib/languages.ts`)
- `locales/en.json` is the master string set; its TS type is `UIStrings`. `lib/languages.ts` lists the ~30 supported languages (code/name/nativeName).
- `getTranslations(code)` returns English directly, else reads the `ui_translations` Supabase cache, else asks Claude **Sonnet** to translate the whole `en.json` (preserving keys and `{placeholders}`) and upserts the result for all future users. Add UI strings to `en.json`; other languages are generated/cached on demand.

### Types
`lib/types.ts` is the single source of truth for `Profile`, `ImmigrationStatus`, `EligibilityBenefit`, `EligibilityResult`, `Document`, `BenefitProgress`, and related enums. The `profiles` table columns mirror these (see `supabase/schema.sql` + `supabase/migration_v2.sql`).

### Database (`supabase/`)
`schema.sql` + `migration_v2.sql` define: `profiles` (24 onboarding vars, RLS per user), `eligibility_results` (JSONB benefits + flagged items), `documents` (+ private `user-documents` storage bucket, folder RLS), `benefit_progress`, and `ui_translations` (global cache, service-role writes). RLS isolates users to their own rows.
