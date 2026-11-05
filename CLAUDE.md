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
  (add `-- --with-test-tenant` for the second tenant, Ferngrove Software, used by isolation checks;
  `-- --empty-workspace` for Juniper Labs, a workspace still in setup)
- Test (unit+integration): `pnpm test` (one file: `pnpm test <name>`) · E2E: `pnpm test:e2e`
  (runs `next dev` on port 3100 and the worker against the `_test` database, queue prefix
  `nexaworks-e2e`: stop any other `next dev` in this folder first)
- Nightly health + signals run for one workspace, through the real queue (safe to re-run):
  `pnpm jobs:nightly --workspace <slug>` (add `--as-of YYYY-MM-DD` to date the run)
- Watcher-basic extraction backfill (M4): `pnpm agents:extract --workspace <slug> [--account "<name>"]`
  (prints which AI transport ran; with no key and `AI_PROVIDER` not `recorded` it writes nothing)
- Live agent eval (outside the gate): `pnpm eval` (prints DEFERRED without `ANTHROPIC_API_KEY`)
- Demo webhook (dev only, M5): `pnpm demo:webhook stripe payment_failed sundial` (or `chargebee payment_failed kestrel --auth user:password`; `--forged` shows the 401)
  — posts a recorded fixture to the running app, signed as the provider signs it
- Demo usage events (dev only, M6): `pnpm demo:usage pinecrest --key <ingest key>` (or `USAGE_API_KEY`)
  — posts recorded product events to the running app's Usage API, Bearer-authenticated with the key shown once on
  Settings › Integrations › Usage API; refuses any address but this machine; a second run is a replay and changes nothing
- Recorded renewal agents (M7, e2e and demo): `AI_PROVIDER=recorded AI_RECORDINGS_DIR=.dev-recordings/<name> pnpm exec tsx --env-file=.env scripts/recorded-renewals.ts --workspace <slug> [--nonce <n>]`
  — composes answers from the records, then runs the Renewal Manager (Northgate) and Expansion Finder (Copperleaf)
  through the real executor; the outreach and the conversation draft land in Approvals, nothing is sent
- Renewal outcome demo (M7, dev only): `pnpm exec tsx --env-file=.env scripts/demo-renewal-outcome.ts --workspace <slug> [--account "<name>"]`
  — adds the successor contract record, then runs `renewals.sync` and the revenue checkpoint for that account;
  records RENEWED with the forecast frozen as it stood (default Harborwood Accounting; re-running changes nothing)
- Outcome checkpoints now (M11): `pnpm outcomes:backfill --workspace <slug>` — runs the 7-day, revenue and frozen
  30/90-day checkpoints through the same functions as the `outcomes.checkpoint` job; safe to re-run
- Leader Reporter weekly digest (M11, dev trigger): `AI_PROVIDER=recorded pnpm reports:digest --workspace <slug>`
  — generates the week's report snapshots, runs the digest through the real queue; idempotent per business week
- Fresh workspace in setup (M5 `/setup` demo): `pnpm db:seed -- --empty-workspace` (Juniper Labs, admin@juniper.test)
- Connectors on recorded fixtures (tests, e2e, demo; refused in production): `INTEGRATIONS_TRANSPORT=fixture`
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

THE PRECISE AI CLAIM (D-75): no LLM produces a health, risk, forecast or money NUMBER; those stay
deterministic code. LLM-labelled extractions may feed components as DATA (e.g. Sentiment) only when
every label's verbatim quote is verified against its source text first; an unverifiable quote is
discarded and logged, never repaired. Numbers in AI narrative must appear in a record it cites.

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
