# CLAUDE.md — NexaWorks AI Customer Success Manager

## What we are building
A complete AI Customer Success Manager SaaS: one product a B2B SaaS company buys INSTEAD OF
Vitally / Gainsight / ChurnZero / Planhat / Totango / Clynto. Not an add-on, not a dashboard
widget, not a service. CSMs start their day here; the AI watches every account, explains
health with proof, runs onboarding/renewals/expansion work, drafts actions for approval,
and reports money saved.
SOURCE OF TRUTH (in this order): 1) the product spec file in the repo root
`ai-customer-success-manager-complete-product-spec-2026-10-31.md` 2) `docs/ARCHITECTURE.md`
3) `docs/IMPLEMENTATION_PLAN.md` 4) this file. If code and spec disagree, the spec wins and
you must flag the disagreement in `docs/QUESTIONS.md` — never silently follow the code.

## Commands (keep this section TRUE — update it the moment a command changes)
- Install: `pnpm install`
- Dev (web + worker): `pnpm dev`  · Web only: `pnpm dev:web` · Worker only: `pnpm dev:worker`
- Local services (canonical): `docker compose up -d postgres redis minio`
  · Fallback without Docker (Homebrew Postgres/Redis/MinIO, same role SQL): `pnpm services:native`
  (needs `.env` with the local-services names from `.env.example`; see DECISIONS D-31)
- Migrate: `pnpm db:migrate` · Generate client: `pnpm db:generate` · Seed demo: `pnpm db:seed`
- Test (unit+integration): `pnpm test` · E2E: `pnpm test:e2e`
- Typecheck: `pnpm typecheck` · Lint: `pnpm lint` · Format check: `pnpm format:check`
- Build: `pnpm build` · Full gate (must pass before any commit): `pnpm gate`
  (= typecheck + lint + test + build, in that order)

## Stack (decided — do not substitute without an entry in docs/DECISIONS.md + my approval)
TypeScript strict everywhere. Next.js (App Router) + React + Tailwind CSS + shadcn/ui.
PostgreSQL + Prisma ORM. Redis + BullMQ for background jobs. Auth.js (credentials + Google)
with database sessions. Zod for ALL validation and for ALL AI structured outputs.
AI via the official Anthropic SDK behind our own provider module in `src/lib/ai/` —
model names/keys come from env only, never hard-coded in features. File storage: S3-compatible
via a storage module. Email sending behind an email module (Resend API key via env; log-only
transport in dev). Vitest + Playwright for tests. pnpm. Docker Compose for local services.
Single modular monolith in ONE repo. NO microservices. NO second framework. NO new ORM.

## Layout
`src/app/` routes (App Router) · `src/modules/<domain>/` one folder per product domain
(accounts, health, signals, agents, plays, renewals, onboarding, inbox, meetings, revenue,
ask-ai, settings…) each with `service.ts`, `schemas.ts`, `actions/API`, `__tests__/`
· `src/lib/` cross-cutting (ai, db, auth, email, storage, jobs, audit) · `src/components/`
shared UI only · `prisma/` schema + migrations + seed · `prompts/` every AI prompt as a
versioned .md file (name + version in frontmatter) · `docs/` plan/architecture/decisions/
questions/milestone logs · Tests live beside the module they test; e2e in `e2e/`.

## Non-negotiable product rules (breaking one = the work is NOT done)
1. PROOF, NOT A SCORE: every health value, risk and AI claim shown to a user must link to
   the exact source records (ids), values, dates and a plain-language reason. No naked numbers.
2. TENANT ISOLATION: every domain query is scoped by `workspaceId`. A query without a
   workspace scope is a bug. Cross-tenant access must be impossible by construction, and
   there must be automated tests that try to break it.
3. APPROVAL BEFORE CUSTOMER CONTACT: nothing is emailed/sent to a customer by default.
   Sending requires the approval flow, or an explicit auto-send setting for that play PLUS
   all auto-send guards in the spec (§6J.4). Sensitive topics (cancel, price, legal,
   security, complaint, escalation) NEVER auto-send — always human.
4. NO INVENTED DATA: if data is missing, the UI/AI says so ("No contract on file").
   AI answers must cite what they checked; an answer with no source is not rendered.
   Missing data never lowers a health score.
5. AUDIT EVERYTHING AI DOES: every agent run writes an AgentRun record — inputs (ids),
   prompt version, model, structured output, reasoning summary, confidence, action taken,
   who approved, outcome later. No orphan AI text anywhere.
6. NO STUBS DISGUISED AS FEATURES: no TODO-placeholder shipped as "done", no mock data in
   production code paths, no hard-coded demo numbers in features. Mocks live in tests/seed only.
7. READ-ONLY BY DEFAULT for external systems; write-back only behind an explicit
   per-integration, per-workspace setting.
8. NEVER TRAIN / SHARE: customer data is never used to train shared models and never leaves
   the workspace boundary in code, logs or prompts to third parties beyond the AI API call
   needed to serve that same workspace.
9. SECRETS: never print, log, commit or echo a secret value. Refer to env vars by name.
   `.env.example` lists names only.

## Working method (every session, every milestone)
EXPLORE → PLAN → BUILD ONE THIN SLICE AT A TIME → VERIFY WITH `pnpm gate` + the milestone's
acceptance checks → UPDATE DOCS (plan checkbox, milestone log, CHANGELOG entry if user-facing)
→ COMMIT ONE LOGICAL SLICE with a Conventional Commit message.
- Tests: core logic (health scoring, signals, play safety checks, auto-send guards, tenant
  scoping, outcome ledger) is built test-first: failing test → implementation → green → refactor.
  UI/API: test alongside. Never edit a test just to make failing code pass; if you believe a
  test is wrong, say why in the milestone log and ask.
- If `pnpm gate` fails, fix the cause. Never disable a check, skip a test, or loosen
  tsconfig/eslint to get green.
- If the spec is ambiguous, write the question in `docs/QUESTIONS.md`, choose the most
  conservative interpretation that matches the spec's intent, note it in `docs/DECISIONS.md`,
  and continue with everything that is NOT blocked. Only stop the whole milestone if the
  ambiguity changes the data model or a non-negotiable rule.
- Keep functions small and typed; no `any` without a comment saying why; Zod-parse every
  external/AI input; server code never trusts client input.
- UI: real, usable screens — never lorem ipsum, never "coming soon" boxes inside a milestone
  marked done. Use the seeded demo workspace to show real states incl. empty/loading/error.
- When you finish: print the milestone's Acceptance Checklist with PASS/FAIL + the evidence
  (command output summary / test names / routes), the files changed, and anything deferred
  (with the milestone it moves to). If anything FAILs, say so plainly. Do not claim green
  you did not run.
