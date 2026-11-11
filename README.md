# MUSTER-AI

An AI Customer Success Manager for B2B SaaS companies. It does the daily CSM job in one product: it watches every account, explains health with the source records behind it, runs renewals and onboarding, drafts customer actions for human approval, and answers questions in Ask AI with citations. It is built to be bought _instead of_ Vitally, Gainsight, ChurnZero, Planhat, Totango or Clynto, not alongside them.

Internally the code and docs still use the name **NexaWorks CSM** (compose project `nexaworks-csm`, `nexaworks-*` queue prefixes, `NexaWorks` in `CLAUDE.md`).

## Status

- Build complete: milestones M1–M12 plus Design 2.0.
- HEAD certified on 2026-11-09 (`docs/HEAD-CERTIFICATION.md`): `pnpm gate` passed with 2,938 tests passing (5 skipped); full e2e 118 passed, 0 failed (75 mobile-project skips are by design).
- Not yet deployed. Pilots have not started.
- Work after the certification (AI cost routing, Ask AI fixes) was verified with targeted suites only; see [Known open items](#known-open-items).

## Architecture in one screen

**Shape.** One modular monolith in one repo. No microservices, no second framework.

```
 Browser ──> Next.js (App Router, Server Actions, route handlers)  ──┐
                                                                     ├──> PostgreSQL 16 (Prisma, RLS)
 Worker process (BullMQ processors, schedules) ─────────────────────┤──> Redis 7 (queues)
                                                                     ├──> S3-compatible storage (MinIO) + ClamAV upload scan
                                                                     └──> Anthropic API (only via src/lib/ai/)
```

- **Web:** Next.js 16 (App Router), React 19, Tailwind, shadcn/ui. TypeScript strict. Zod validates all external input and all AI structured output.
- **Worker:** `src/worker/` runs BullMQ jobs: nightly health and signals, sweeps, batch collection, outcomes, reports, integrations sync.
- **Auth:** Auth.js (credentials + Google) with database sessions.
- **Tenant isolation (`docs/ARCHITECTURE.md` §7.1).** Every domain query is scoped by `workspaceId`.
  1. Application: `scopedDb(ctx)` (`src/lib/db/scoped.ts`) injects `workspaceId` into every workspace-scoped model operation and throws on a mismatch. The raw Prisma client is import-restricted by an ESLint rule.
  2. Database: Postgres row-level security, `ENABLE` + `FORCE` on every workspace table, keyed on `app.workspace_id`. The app connects as non-owner `app_user`; migrations run as the owner role.
  3. Composite foreign keys `(workspaceId, id)` make cross-tenant references impossible.
     Tests try to break all three (`src/lib/db/__tests__/tenant-isolation.test.ts`, and `tenant-enumeration.int.test.ts`, which discovers every server action, route handler and Ask AI tool and calls each with another workspace's ids).
- **AI layer (`src/lib/ai/`, agents in `src/modules/agents/`).** Model names and keys come from env only. Every prompt is a versioned file in `prompts/`. Every agent run writes an `AgentRun` record (inputs by id, prompt version, model, output, confidence, action, approver).
  - **No LLM produces a health, risk, forecast or money number.** Those are deterministic code. Numbers in AI narrative must appear in a record the answer cites.
  - **Citation guard.** Each citation must resolve to a record in that run's context, and each quote must be a verbatim substring of it. Failures end the run as `UNCITED` and nothing is rendered. Ask AI shows records to the model with short handles (`R1`, `R2`…) that code maps back to real ids before the unchanged checker runs.
  - **Routing (`src/lib/ai/routing.ts`).** Every job runs on the **fast** tier (`AI_MODEL_FAST`, Haiku) except two jobs on the **deep** tier (`AI_MODEL_DEEP`, Sonnet): the Ask AI final answer and the Leader Reporter weekly digest. Ask AI's planning step is on the fast tier. `routing.test.ts` pins this.
  - **Batch API.** Bulk sweeps (Health Analyst, Renewal Manager, Expansion Finder, Watcher backfill, Promise Keeper, Onboarding/Adoption) go as one Message Batches request per pass at half price. `agents.collectBatches` runs every 5 minutes and finishes results through the same code as a real-time answer; if the account's records changed meanwhile, the run is skipped as stale. Interactive work stays real time.
  - **Change-only gate.** A run whose exact inputs hash identically to the last successful run (same agent and prompt version) makes no call.
  - **Budgets.** Workspace setting `ai.monthlyTokenBudget`, default 10,000,000 tokens per calendar month. At 80% Admins and CS Leaders are notified; at 100% every job except Ask AI is skipped. Prices for the cost estimate live only in `src/config/ai-pricing.ts`.
  - **Prompt caching** markers are sent on the system prompt; they save little on Haiku (below its minimum cacheable prefix) and help the Sonnet jobs.
  - **Ask AI limits.** Interactive runs get at most 2 attempts, a timeout is never retried, and a whole question is capped at 80 s.
- **Approval before customer contact.** Nothing is sent to a customer without approval, or an explicit per-play auto-send setting plus every guard in spec §6J.4. Sensitive topics (cancel, price, legal, security, complaint, escalation) never auto-send.
- **External systems are read-only by default**; write-back needs a per-integration, per-workspace setting.

## Repo map

| Path                                                   | What lives there                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                                             | Routes. `(app)/` is the signed-in product (today, accounts, health, approvals, tasks, onboarding, renewals, expansion, plays, inbox, promises, revenue, reports, ask, meetings, settings, setup); also `api/`, `portal/`, `s/` (public surveys), `invite/`, `sign-in/`, `unsubscribe/`. |
| `src/modules/<domain>/`                                | One folder per product domain (about 40, e.g. accounts, health, signals, agents, plays, renewals, onboarding, ask-ai, outcomes, integrations). Each has service, schemas, actions/API and tests beside it.                                                                              |
| `src/lib/`                                             | Cross-cutting code: `ai`, `db` (scoped client, RLS), `auth`, `email`, `storage`, `jobs`, `audit`, `crypto`, `security`, `uploads`, `observability`, `rate-limit`, `config` (env validation).                                                                                            |
| `src/worker/`                                          | Worker entrypoint and job processors.                                                                                                                                                                                                                                                   |
| `src/components/`, `src/config/`                       | Shared UI only; static config (e.g. AI pricing).                                                                                                                                                                                                                                        |
| `prisma/`                                              | Schema, migrations, seed (`prisma/seed/`, `seed.ts`, `seed-scale.ts`).                                                                                                                                                                                                                  |
| `prompts/`                                             | Every AI prompt as a versioned `.md` file with name, version and tier in frontmatter; `__golden__/` holds recorded fixtures.                                                                                                                                                            |
| `e2e/`                                                 | Playwright specs. `playwright.config.ts` (recorded AI) and `playwright.aioff.config.ts` (no AI).                                                                                                                                                                                        |
| `scripts/`                                             | Operational and demo scripts (e2e runner, nightly job, deploy release, healthcheck, secret scan, evals, demos).                                                                                                                                                                         |
| `docker/postgres/`, `docker-compose.yml`, `Dockerfile` | Local and production-style services; role and grant SQL.                                                                                                                                                                                                                                |
| `fixtures/`                                            | Recorded connector payloads.                                                                                                                                                                                                                                                            |
| `docs/`                                                | Everything below.                                                                                                                                                                                                                                                                       |

**Key docs** (source-of-truth order from `CLAUDE.md`: the product spec, then ARCHITECTURE, then IMPLEMENTATION_PLAN, then CLAUDE.md):

| Doc                                                               | One line                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ai-customer-success-manager-complete-product-spec-2026-10-31.md` | The product spec (repo root). Wins when code disagrees.                                              |
| `CLAUDE.md`                                                       | Commands, stack, the nine non-negotiable product rules, working method.                              |
| `docs/ARCHITECTURE.md`                                            | Modules, data model, agents, jobs, security design, test strategy.                                   |
| `docs/IMPLEMENTATION_PLAN.md`                                     | Milestones M1–M12 and their acceptance checks.                                                       |
| `docs/DECISIONS.md` / `docs/QUESTIONS.md`                         | Numbered decisions (D-n) and open or resolved questions (Q-n).                                       |
| `docs/milestones/`                                                | Per-milestone briefs and logs (`M1`…`M12`, Design 2.0 logs) and evidence images.                     |
| `docs/HEAD-CERTIFICATION.md`                                      | The certified gate and e2e result.                                                                   |
| `docs/AI-COST-2026-11-11.md`                                      | Routing, Batch API, caching, budgets, the Haiku vs Sonnet eval.                                      |
| `docs/FIX-2026-11-11.md`, `docs/FIX-2026-11-11-ASK2.md`           | Latest fix logs: Today/renewals, and Ask AI (named-account lookup, portfolio tool, handles, limits). |
| `docs/REVIEW-2026-11-*.md`                                        | Dated product reviews and their fix logs.                                                            |
| `docs/SECURITY.md`, `docs/DATA_MAP.md`, `docs/RULES_CHECK_MAP.md` | Security posture, where data lives, where each product rule is enforced.                             |
| `docs/SEED_DATA.md`                                               | The demo workspace design and user list.                                                             |
| `docs/SETUP_GUIDE.md` / `docs/ADMIN_GUIDE.md`                     | Customer-facing setup and admin guides.                                                              |
| `docs/DOCKER-VERIFICATION.md`                                     | Container boot, release, and backup/restore drill results.                                           |

## Run it locally

Requires Node >= 22.12 and pnpm.

**Native dev** (from `CLAUDE.md`):

```bash
pnpm install
cp .env.example .env        # fill values locally; see Environment below
docker compose up -d postgres redis minio   # canonical local services
# no Docker? pnpm services:native  (Homebrew Postgres/Redis/MinIO, same role SQL; see DECISIONS D-31)
pnpm db:migrate
pnpm db:seed                # demo workspace "larkspur-demo"
pnpm dev                    # web + worker  (pnpm dev:web / pnpm dev:worker separately)
```

Seed variants: `pnpm db:seed -- --with-test-tenant` (second tenant, Ferngrove Software, for isolation checks); `-- --empty-workspace` (Juniper Labs, a workspace still in setup). Derived data (health, signals) comes from the real pipeline: `pnpm jobs:nightly --workspace larkspur-demo`.

**Docker route** (production-style stack: postgres, redis, minio, clamav, web, worker):

```bash
docker compose up -d --build     # compose refuses to start if a required variable in .env is empty
docker compose exec web pnpm deploy:release   # migrate, apply role grants, healthcheck
```

The demo seed refuses to run when `NODE_ENV=production`; on a throwaway demo stack set `ALLOW_DEMO_SEED=true` for the one seed run (see `docs/DOCKER-VERIFICATION.md`). A cold ClamAV can take about a minute to load signatures, so the release's healthcheck may fail the first time; re-run it.

**Demo logins:** the user list (names, emails, roles) is in `docs/SEED_DATA.md`; credentials are defined only in `prisma/seed/users.ts`, never in docs.

Useful demos (full list in `CLAUDE.md`): `pnpm demo:webhook`, `pnpm demo:usage`, `pnpm outcomes:backfill`, `pnpm reports:digest`, `pnpm agents:extract`.

## Environment

Names only; copy `.env.example` to `.env`. Never commit values. Format and validation rules live in `src/lib/config/env.ts`, and production refuses unsafe settings.

| Variable                                                                            | Purpose                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | Runtime mode.                                                                     |
| `APP_URL`                                                                           | Public base URL of the app.                                                       |
| `DATABASE_URL`                                                                      | Runtime Postgres connection (non-owner `app_user`).                               |
| `DATABASE_URL_MIGRATE`                                                              | Migration connection (owner role).                                                |
| `REDIS_URL`                                                                         | Redis for BullMQ.                                                                 |
| `QUEUE_PREFIX`                                                                      | BullMQ queue name prefix (isolates e2e/script workers).                           |
| `NIGHTLY_SCHEDULES`                                                                 | `off` stops the worker registering nightly schedules (e2e only).                  |
| `APP_ENV`                                                                           | Deployment kind: production, staging, e2e. Test seams need `e2e` and a `_e2e` DB. |
| `RATE_LIMIT_SCALE`                                                                  | Test only: multiplies rate limits; refused outside the e2e build.                 |
| `ALLOW_FAKE_CLOCK`, `APP_FAKE_NOW`                                                  | Test only: fake business clock; ignored in production.                            |
| `AUTH_SECRET`                                                                       | Auth.js session secret.                                                           |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`                                              | Google sign-in.                                                                   |
| `AI_PROVIDER`                                                                       | AI transport (`anthropic`, or `recorded` for tests and demo replay).              |
| `ANTHROPIC_API_KEY`                                                                 | Anthropic API key.                                                                |
| `AI_MODEL_FAST`, `AI_MODEL_STANDARD`, `AI_MODEL_DEEP`                               | Model ids per tier.                                                               |
| `AI_RECORDINGS_DIR`                                                                 | Recorded provider only: where recordings live.                                    |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `RESEND_API_KEY`                                   | Email sending (Resend); log-only transport in dev, refused in production.         |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible file storage (MinIO locally).                                       |
| `FIELD_ENCRYPTION_KEY`                                                              | Encrypts stored integration secrets.                                              |
| `LOG_LEVEL`                                                                         | Log verbosity.                                                                    |
| `INTEGRATIONS_TRANSPORT`                                                            | `live` or `fixture` (recorded payloads; refused in production).                   |
| `WRITE_BACK_LIVE`                                                                   | `true` allows write-back pushes over the live transport.                          |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`                                        | HubSpot OAuth app.                                                                |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`                                  | Salesforce OAuth app.                                                             |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`                    | Slack app.                                                                        |
| `SLACK_DELIVERY`                                                                    | `log` (files in `.dev-slack/`, dev only) or `live`.                               |
| `GOOGLE_EMAIL_CLIENT_ID`, `GOOGLE_EMAIL_CLIENT_SECRET`                              | Gmail connector OAuth app.                                                        |
| `MICROSOFT_EMAIL_CLIENT_ID`, `MICROSOFT_EMAIL_CLIENT_SECRET`                        | Microsoft email connector OAuth app.                                              |
| `STRIPE_WEBHOOK_SECRET`                                                             | Dev `demo:webhook` script only.                                                   |
| `CLAMD_HOST`, `CLAMD_PORT`, `CLAMD_SOCKET`, `CLAMD_TIMEOUT_MS`                      | ClamAV upload scanning; production refuses to boot without host or socket.        |
| `POSTGRES_PASSWORD`, `OWNER_DB_PASSWORD`, `APP_DB_PASSWORD`                         | Local/compose Postgres role passwords.                                            |
| `ERROR_TRACKING_DSN`, `APP_RELEASE`                                                 | Error tracking DSN and release label.                                             |
| `DEV_ALLOWED_ORIGINS`                                                               | Dev only: extra hosts allowed to load the dev server.                             |

## Testing

| What                        | Command                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration (Vitest) | `pnpm test` (one file: `pnpm test <name>`). Integration tests are `*.int.test.ts` beside the module and use a real Postgres.                                                                                                                  |
| E2E (Playwright)            | `pnpm test:e2e [spec files, -g, --project]`. Builds and serves the production app on :3100 (recorded AI) and :3101 (no AI), plus a worker, against a recreated `_e2e` database. Needs a local Postgres superuser. No live model is reachable. |
| Typecheck / lint / format   | `pnpm typecheck` · `pnpm lint` (ESLint plus the secret scan) · `pnpm format:check`                                                                                                                                                            |
| Full gate                   | `pnpm gate` = typecheck + lint + test + build.                                                                                                                                                                                                |
| Live AI eval                | `pnpm eval` (prints DEFERRED without `ANTHROPIC_API_KEY`); outside the gate.                                                                                                                                                                  |

Economics rules:

- Per change, run the targeted suites and e2e specs for the code you touched, not the whole suite.
- Run one full `pnpm gate` (and the full e2e) at milestone close or certification.
- Never disable a check, skip a test, or edit a test only to make code pass.

## Deploy

Self-hosted Docker Compose (`docker-compose.yml`; verified on one machine in `docs/DOCKER-VERIFICATION.md`).

- **Order:** build the images, then run migrations before swapping web and worker: `pnpm deploy:release` runs `prisma migrate deploy`, reconciles `app_user` grants from `docker/postgres/grants.sql`, then runs the healthcheck. A worker started against an unmigrated database crash-loops until migrations apply.
- **Health probes:** `GET /api/health` (no sign-in; 200 while database and Redis answer). `scripts/healthcheck.ts` probes database, Redis, ClamAV, the worker heartbeat and the web server. Inside a container use `pnpm exec tsx scripts/healthcheck.ts` (the `pnpm healthcheck` script needs a `.env` the image does not have).
- **Backups:** Postgres must be dumped (`pg_dump -Fc`) and the dumps kept **off the host**. The drill in `docs/DOCKER-VERIFICATION.md` proved dump, wipe and `pg_restore` on one machine; scheduling and off-box copying are not built in the repo. Retention stated to customers is 35 days (`docs/ADMIN_GUIDE.md`); the real deployment's retention is an operations setting and is unverified.
- **Restart policy:** every service must have `restart: unless-stopped`. In `docker-compose.yml` today `clamav`, `web` and `worker` have it; `postgres`, `redis` and `minio` do not (see open items).
- **Production guards:** the app refuses log-only email and Slack transports, a missing ClamAV, and the fixture integrations transport. Compose requires `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `REDIS_URL`, `AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`, `EMAIL_FROM`, `RESEND_API_KEY`, `APP_URL`.

## Known open items

- **Connectors are fixture-verified only.** HubSpot, Salesforce, Slack, Gmail/Microsoft email and webhooks have been exercised against recorded fixtures; no live CRM has been connected.
- **Resend is not connected.** Live email sending has never been run; Docker verification used placeholder values.
- **First live Batch API run not yet observed.** Batch submission and collection are tested against fakes only; the first real batch is the thing to watch. The other agents moved to Haiku (renewals, expansion, outreach, QBR narrative, digest) have not been run live on Haiku; only extraction and Ask AI were.
- **Number-guard quirk (parked).** The Ask AI number check matches any digit run, including digits inside the random ids in a record's fields, so whether a stray numeral passes is partly chance. It errs lenient in some places and strict in others. Left unchanged; it needs its own look (`docs/FIX-2026-11-11-ASK2.md`).
- **Post-certification changes are not under a full certification.** The AI-cost and Ask AI fixes were verified with targeted suites only. The Docker demo stack must be rebuilt and `deploy:release` run to pick up their migrations.
- **Restart policy gap:** `postgres`, `redis` and `minio` lack `restart: unless-stopped` in `docker-compose.yml`.
- **ClamAV readiness:** its compose healthcheck always reports healthy and web/worker only wait for `service_started`, so the release healthcheck can fail on a cold start.
- **Flaky test:** `score-as-of.int.test.ts` ("identical result and inputs after the post-date plants") has failed intermittently in full runs and passes alone.
- Open founder questions are listed in `docs/QUESTIONS.md`.
