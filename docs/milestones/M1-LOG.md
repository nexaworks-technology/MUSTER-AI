# M1 log: Foundation, Auth & Tenancy

**Date:** 2026-11-02 · **Result:** 15 of 16 acceptance checks PASS. **#16 is PARTIAL** (Docker not installed; founder-approved, open follow-up).
**Commits:** `ec75866` … `64f3880` (15 slice commits after the planning-docs commit `c6babc7`), plus this docs commit.

## What was built
- **Scaffold and tooling.**
  - Next.js 16 App Router, React 19, TypeScript 5.9 strict, Tailwind v4 and shadcn/ui.
  - ESLint with import boundaries, Prettier, Vitest 5, Playwright and axe.
  - Every pnpm script in CLAUDE.md, including `gate`. Versions are exact-pinned (D-32).
- **Local services.**
  - `docker-compose.yml` is canonical: Postgres 16, Redis, MinIO, explicit project name, credentials from `.env` only.
  - `pnpm services:native` is the Homebrew fallback and applies the same `docker/postgres/roles.sql` (D-31).
  - Postgres has two roles: `nexaworks_owner` runs migrations; `app_user` runs the app and is not superuser, not owner, and NOBYPASSRLS.
- **Data model.**
  - Workspace, User, AuthAccount, Session (with `activeWorkspaceId`), VerificationToken.
  - Workspace-scoped: Membership, Invitation, WorkspaceSettings, AuditLog. Plus the global OutboxEvent.
  - Every workspace-scoped table has `@@unique([workspaceId, id])` and RLS ENABLE + FORCE with a `tenant_isolation` policy. Invitation points at its inviter through a composite foreign key.
  - Two narrow read-only policies: a user can read their own memberships, and an invite-link holder can read exactly that invitation.
  - AuditLog has an append-only trigger.
- **Tenancy (`src/lib/db`).**
  - `scopedDb(ctx)` adds the workspace to every query and throws `TenantViolationError` on a foreign workspace.
  - It also wraps every operation in an `app.workspace_id` transaction for RLS.
  - It provides `$tenantTransaction` and refuses `$queryRawUnsafe` / `$executeRawUnsafe`.
  - The raw client is import-restricted. `TENANT_MODELS` is the registry of workspace-scoped models, and `prisma/sql/rls.ts` generates the RLS SQL for new ones.
- **Auth (`src/lib/auth`).**
  - Auth.js v5 with Google and email/password, using **database sessions** (D-07, implemented per D-33).
  - The `AuthAccount` adapter stores OAuth tokens encrypted (D-08). Passwords use argon2id.
  - `getWorkspaceContext` takes the workspace from the user's own memberships. The workspace switcher refuses non-memberships.
  - `requirePermission` implements the full ARCHITECTURE §7.2 matrix, plus the `canViewRevenue` flag and book scope.
- **Audit (`src/lib/audit`).** `writeAudit` redacts anything that looks like a secret. These events are audited (D-34):
  - `auth.signed_in`, `auth.signed_out`, `auth.failed`;
  - `invitation.created`, `invitation.revoked`, `invitation.accepted`;
  - `membership.updated`, `membership.deactivated`;
  - `workspace.updated`, `seed.applied`.
- **Settings.**
  - **Settings › Users:** list members, invite, revoke an invitation, change role / revenue access / book scope, deactivate. The last active admin is protected.
  - **`/invite/[token]`:** a new user joins and is signed straight in; an existing user, signed in, accepts. Invalid, expired, used and revoked links each get an honest message.
  - **Settings › Workspace:** name, IANA time zone, ISO currency.
- **App shell.**
  - Navigation uses the spec's screen names and is gated by `src/config/features.ts`. Unbuilt screens are hidden and their URLs 404.
  - Workspace switcher, sign-out, skip link, and a Home page showing the workspace and the user's access. Layout is responsive down to 375 px.
- **Jobs.**
  - Eight BullMQ queues.
  - A transactional outbox (D-22) dispatched with SKIP LOCKED and the event id as job id.
  - A worker with heartbeat and outbox-dispatch schedules and graceful shutdown. `pnpm dev` runs web and worker.
- **AI (`src/lib/ai`).** No agents yet.
  - Provider interface with model tiers from env only.
  - Anthropic provider using `output_config.format` structured output (D-35).
  - `RecordedProvider`, refused in production.
  - Versioned prompt loader and `prompts/README.md`.
- **Other libraries.**
  - **Crypto:** AES-256-GCM with a key-id prefix and support for key rotation.
  - **Money:** bigint minor units; never mixes currencies.
  - **Storage:** S3/MinIO; keys are always under `ws/<workspaceId>/`.
  - **Email:** staff transports only (log-only for dev and test, Resend for production). The customer transport is import-restricted and arrives in M4.
  - **Logger:** pino with redaction paths.
- **Config.** `PRODUCT_NAME` (a guard test keeps the literal out of all other code) and `pricing.ts` (structure only, `isFinal: false`).
- **Seed v0** (`pnpm db:seed`). Larkspur Analytics with Priya (Admin), Dana (CS Leader), Leo and Aisha (CSM) and Tom (Viewer). Revenue access is limited to Priya and Dana. `--with-test-tenant` adds Ferngrove Software. Ids are stable and the seed only upserts.

## Acceptance checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | Last run on `64f3880` (`typecheck → lint → test → build`, in that order). Typecheck: 0 errors. Lint: 0 problems, secret check 155 files, none found. Test: 22 files, 199 tests passed. Build: compiled successfully, 7 routes. |
| 2 | `pnpm test:e2e` green for `e2e/m1-foundation.spec.ts` | **PASS** | 8 passed, 2 skipped (the foundation flow is desktop-only by design). Tests: `M1 foundation › sign-in, members, invitation, access change and audit trail`, `… › another tenant's admin sees only their own workspace (Rule 2)`, plus 3 axe tests × 2 viewports. |
| 3 | Credentials sign-in uses **database sessions** | **PASS** | `src/lib/auth/__tests__/credentials-session.int.test.ts` drives the real Auth.js handlers: "creates a Session row whose token is the session cookie value" (opaque token, not a JWT), "signs the user out when the Session row is deleted", "the session endpoint reads the session from the database". Session rows were observed in the dev DB during the manual demo. |
| 4 | Google provider configured from env only | **PASS** (config) | `src/lib/config/env.ts` (`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, must be set together, test "requires Google id and secret together"). `src/lib/auth/config.ts` passes `env()` values only. No client ids in the repo (secret check). Live Google sign-in is **not verified**: no Google OAuth credentials exist yet (see Deferrals). |
| 5 | Tenant isolation: read/update/delete/raw/RLS/composite-FK all blocked (Rule 2) | **PASS** | `tenant-isolation.int.test.ts`: tests 1, 2, 3, 4, 4b (RLS WITH CHECK), 5 (composite FK, P2003), 6 (unsafe raw refused), plus tenant transactions. `settings.int.test.ts › cannot touch a member of another workspace`. e2e: Ferngrove admin sees no Larkspur users. |
| 6 | Every [W] model registered with RLS + composite unique | **PASS** | `model-registry.int.test.ts`: every model classified exactly once; per-model `workspaceId` + `@@unique([workspaceId, id])`; RLS enabled + forced + `tenant_isolation` (via `pg_class`/`pg_policies`); runtime role is not superuser and has no BYPASSRLS. |
| 7 | Raw Prisma client and customer transport are import-restricted | **PASS** | `eslint.config.mjs` plus fixtures in `src/lib/__tests__/lint-fixtures/`, asserted by `src/lib/__tests__/lint-boundaries.test.ts` (5 tests: raw DB blocked in modules and allowed in `src/lib/db` / `src/lib/auth`; customer transport blocked everywhere except `src/modules/outbound/dispatch.ts`; `PrismaClient` construction blocked; module internals blocked). No placeholder `customerTransport.ts` exists, per founder decision. |
| 8 | RBAC matrix implemented server-side | **PASS** | `src/lib/auth/__tests__/permissions.test.ts`: 91 tests, every matrix cell × role, book-scope widening, revenue flag for every role (admins included), Viewer can never mutate. Services call `requirePermission` (`settings.int.test.ts › only admins may invite`, `… is admin-only`). |
| 9 | Audit rows on sign-in, invite, role change; AuditLog append-only (Rule 5 base) | **PASS** | `audit.int.test.ts` (row written; UPDATE and DELETE rejected through the scoped client and raw SQL; redaction). `credentials-session.int.test.ts` (auth.failed without the password; signed_in/signed_out). e2e asserts `auth.signed_in`, `auth.failed`, `invitation.created`, `invitation.accepted`, `membership.updated` and that UPDATE fails. In psql as the Postgres superuser, `UPDATE "AuditLog"` → `ERROR: AuditLog is append-only: UPDATE is not allowed`. |
| 10 | No secret in repo; `.env.example` names only (Rule 9) | **PASS** | `scripts/check-secrets.ts` runs inside `pnpm lint`: "155 files scanned, no secrets found". `.env.example` has every line as `NAME=` (enforced by the scanner; `secret-patterns.test.ts`). `.env` is git-ignored with mode 600. |
| 11 | `PRODUCT_NAME` used everywhere; no literal product name elsewhere | **PASS** | `git grep -n "NexaWorks AI CSM" -- . ':!docs' ':!*.md'` returns only `src/config/product.ts:5`. Guard test `src/config/__tests__/product-name.test.ts`. |
| 12 | Pricing config `isFinal: false`; no price rendered | **PASS** | `src/config/pricing.ts` (`isFinal: false`, no amounts, empty plan list). `git grep -nE '[$€£¥][0-9]' -- src/app` returns nothing. |
| 13 | AI model names only from env | **PASS** | `git grep -n "claude-" -- src` returns nothing. Tiers map to `AI_MODEL_FAST/STANDARD/DEEP` (`src/lib/ai/index.ts`). `providers.test.ts` checks the configured env model is used. |
| 14 | No "coming soon" UI; unbuilt nav hidden (Rule 6) | **PASS** | `git grep -in "coming soon" -- src` returns nothing. `features.test.ts`: M1 shows Home (all) and Settings (admin only); items without a real route are never shown. The manual demo confirmed the nav shows Home + Settings for Priya and Home only for a CSM. |
| 15 | axe: no serious/critical violations on sign-in, Home, Settings › Users at 1280 and 375 px | **PASS** | `e2e/a11y.spec.ts` (WCAG 2.1 AA tags) on sign-in, Home, Settings › Users, Settings › Workspace and the invitation page, desktop and mobile projects: 6/6 passed. |
| 16 | CLAUDE.md Commands section true | **PARTIAL** | Each command was run once on 2026-11-02 and the results are below. **`docker compose up -d postgres redis minio` returned exit 127 (`docker` not installed).** Every other command passed. The fallback `pnpm services:native` was used, as approved. **Open follow-up:** install Docker, run the compose command, and record its output here. |

### #16 command results
The first run of `pnpm install` failed (`ERR_PNPM_IGNORED_BUILDS: msgpackr-extract`). It was fixed in `64f3880` (D-38) and re-run successfully.

| Command | Result | Notes |
|---|---|---|
| `pnpm install` | exit 0 | After the D-38 fix. |
| `docker compose up -d postgres redis minio` | **exit 127** | `docker` is not installed. |
| `pnpm services:native` | exit 0 | Postgres 14, Redis and MinIO running; roles and databases ready. |
| `pnpm db:migrate` | exit 0 | Already in sync. |
| `pnpm db:generate` | exit 0 | Generated Prisma Client 6.19.3. |
| `pnpm db:seed` | exit 0 | Larkspur Analytics ready. |
| `pnpm db:seed -- --with-test-tenant` | exit 0 | Adds Ferngrove Software. |
| `pnpm dev:web` | running | `/sign-in` returned HTTP 200. |
| `pnpm dev:worker` | running | "worker started". |
| `pnpm dev` | running | Web HTTP 200 and worker started. |
| `pnpm test` | exit 0 | 199 tests passed. |
| `pnpm test:e2e` | exit 0 | 8 passed. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | exit 0 | — |
| `pnpm build`, `pnpm gate` | exit 0 | — |

## Demo script (run 2026-11-02)
1. **Start-up.** The docker step was replaced by `pnpm services:native` (see #16), then `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`.
2. **Sign-in page.** `/` redirects to Sign in, which shows "NexaWorks AI CSM" from `PRODUCT_NAME`.
3. **Admin home.** Priya signs in and Home shows "Larkspur Analytics", role Admin, revenue access Yes.
4. **Members.** Settings › Users lists 5 members; Priya and Dana show "Revenue access".
5. **Invite.** Inviting `newcsm@larkspur.test` as CSM writes the link to `.dev-mail/` via the log transport.
6. **Accept.** After signing out, opening the link and joining as "Nina Park" lands in Larkspur as CSM. Nav shows Home only, and `/settings/users` returns 404.
7. **Change access.** Changing Leo's book scope to Team shows "Saved." This step was run by the e2e test, not by hand.
8. **Audit trail.** AuditLog rows in the dev DB: `auth.signed_in` ×2, `auth.signed_out`, `invitation.created`, `invitation.accepted`, `seed.applied`. In the test DB, e2e also adds `auth.failed` and `membership.updated`. `UPDATE "AuditLog"` in psql returns an error.
9. **Isolation.** The demo's `pnpm test -- tenant-isolation` runs the whole suite, because pnpm passes the `--` through and Vitest then ignores the filter. **Use `pnpm test tenant-isolation`.** That command now appears in CLAUDE.md as `pnpm test <name>`. All 10 isolation tests passed.

## Files changed (since the planning commit)
141 files, about 15.2k lines including `pnpm-lock.yaml`:
- **Tooling:** root config, `docker-compose.yml`, `docker/postgres/`, `scripts/`.
- **Database:** `prisma/` (schema, one migration with RLS and the audit trigger, seed, RLS helper, README).
- **App:** `src/app/` (sign-in, invite, `(app)` shell, Home, Settings, auth route), `src/components/{ui,app}/`, `src/config/`.
- **Libraries:** `src/lib/{ai,audit,auth,config,crypto,db,email,jobs,logger,money,storage}/`.
- **Modules and worker:** `src/modules/settings/`, `src/worker/`, `src/test/` (test harness).
- **Tests and prompts:** `e2e/`, `prompts/README.md`.
- **Docs:** `CHANGELOG.md`, CLAUDE.md (Commands only), `docs/{ARCHITECTURE,DECISIONS,QUESTIONS,IMPLEMENTATION_PLAN}.md`, this log.
- **`AGENTS.md`:** written automatically by `next dev` (Next.js agent notes). It was committed with the e2e slice; `next dev` re-creates it whenever it is removed.

## Decisions added
- **D-31** Compose canonical + native fallback, chainguard MinIO image, Postgres 14-vs-16 risk.
- **D-32** Pinned toolchain.
- **D-33** How D-07 is implemented; Google rules.
- **D-34** Per-workspace auth audit.
- **D-35** Structured output via `output_config.format`. ARCHITECTURE §1.3 and D-06 were updated to match.
- **D-36** Test database migrated, never reset by tooling.
- **D-37** e2e on `next dev` against `_test`.
- **D-38** Install-script allow-list.
- **D-39** Per-page Settings access checks.
- **D-40** Tagged-raw-SQL lint rule deferred to M3.

## Questions added
- **Q-34** Docker absent. Answered by the founder: use the fallback; #16 stays PARTIAL.
- No other open ambiguities. Every other default in QUESTIONS.md stands as approved.

## Deferrals
| Item | Moves to | Why |
|---|---|---|
| Run `docker compose up -d postgres redis minio` and close #16 | **Open follow-up, next session with Docker installed** | Docker is not on this machine. The compose file, the MinIO image tag (`chainguard/minio:latest`) and the init script are unverified. |
| Live Google sign-in check | When Google OAuth credentials exist (M5 at the latest, with other OAuth setup) | No credentials yet. The configuration path is tested. |
| Live Resend send check | M4 (first customer send) / M12 | No `RESEND_API_KEY`. The transport is unit-tested with a stubbed `fetch`. |
| Lint rule: tagged `$queryRaw` must reference `ctx.workspaceId` | M3 | D-40. RLS already scopes raw queries on the scoped client. |
| Server Action enumeration tenant test | M12 (as planned) | M1 actions are covered by service-level tenant tests. |
| Refusal-fallback policy for the AI provider | M4 | D-35. Depends on which models get configured. |
| Upload safety (MIME sniffing, size cap, malware-scanner hook) | M2 (FileObject) / M12 | M1 ships only the storage wrapper with workspace-prefixed keys. |
| Customer email transport, `dispatch`, all auto-send guards, sensitive-topic check | **M4: the same milestone as the first customer send** (standing founder guardrail) | M1 sends only internal staff invitations. |
| Production-build e2e (`next start`) | M12 staging smoke | D-37. |

## Known risks
1. **Postgres version drift.** Native Postgres is 14 and compose specifies 16. No 16-only feature is used. Any future use needs a DECISIONS entry (D-31).
2. **Auth.js v5 is still beta** (`5.0.0-beta.32`). The database-session approach relies on the credentials flow calling `callbacks.jwt` and then `jwt.encode` (D-33). Any Auth.js upgrade must re-run `credentials-session.int.test.ts` first.
3. **RLS transaction overhead.** Every scoped operation runs in its own `set_config` transaction. That's fine at M1 scale; M2/M3 must use `$tenantTransaction` for multi-query paths and keep the planned query-budget tests.
4. **Test DB accumulates rows.** Tests are written to tolerate that (D-36). A human can reset it when needed.
5. **The compose MinIO image is a moving `latest` tag** (D-31), unverified until Docker is available.

## Proposed commit message (this docs commit)
```
docs(m1): milestone log, acceptance results, changelog and decisions D-36–D-40
```

## What M2 should know
- **New workspace-scoped models must follow `prisma/README.md`:**
  1. Add `workspaceId` and `@@unique([workspaceId, id])`.
  2. Use composite FKs to other workspace-scoped parents.
  3. Append the RLS block from `pnpm exec tsx prisma/sql/rls.ts <Model>` to the migration.
  4. Add the model to `TENANT_MODELS` and to `tenant-isolation.int.test.ts`.
  `model-registry.int.test.ts` fails the gate if any step is missed.
- **Database access.** Feature code uses `scopedDb(ctx)` only, passes `workspaceId: ctx.workspaceId` in creates, and uses `$tenantTransaction` for multi-step writes (with `writeAudit(entry, tx)` and `writeOutboxEvent(tx, …)`).
- **Permissions.** Use the names in `src/lib/auth/permissions.ts` (e.g. `accounts:view`, `accounts:edit`, `revenue:view`). Book-scoped grants return `{ scope: "OWN" | "TEAM" | "ALL" }`, and M2 applies them to the account owner. Financial fields need `revenue:view`.
- **Navigation.** Add a screen by setting its `href` in `src/config/features.ts`, raising `SHIPPED_MILESTONE` to 2, and updating `features.test.ts`. Settings-style pages must check access on the page itself (D-39).
- **Seed users.** Larkspur Analytics (`larkspur-demo`): `admin@larkspur.test` Priya (Admin, revenue), `dana@` Dana (CS Leader, revenue), `leo@` Leo (CSM), `aisha@` Aisha (CSM), `tom@` Tom (Viewer). Ferngrove Software (`ferngrove-test`): `admin@ferngrove.test`. The dev-only password is in `prisma/seed/users.ts`. M2 extends the seed with the SEED_DATA accounts.
- **Testing.** `pnpm test:e2e` needs no other `next dev` running in this folder.
