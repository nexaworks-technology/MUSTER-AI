# M2 log: Data Core (CSV Import, Account Graph, Accounts and Account 360)

**Date:** 2026-11-02 · **Result:** 14 of 14 M2 acceptance checks PASS. M2 is complete.
**Carried from M1, unchanged:** M1 acceptance **#16 is PARTIAL** (Docker not installed; founder-approved, open follow-up). No docker command was run in M2.

## What was built

Fifteen slices, one Conventional Commit each (`ac98182` … `95215b5`), `pnpm gate` green after every slice, tests written first.

| # | Slice | Commit |
|---|---|---|
| 1 | Account, Contact, StakeholderRole with tenancy (RLS, composite FKs, registry); seed roster | `ac98182` |
| 2 | Accounts list: server-paginated, search, filters, sort, book scope | `ac133b5` |
| 3 | Account 360: Overview and People, champion designation | `dba7c38` |
| 4 | Contracts, subscriptions, invoices, rule-derived revenue events, encrypted terms, revenue redaction | `3710c0d` |
| 5 | Usage aggregates, Usage tab chart with data table, seeded usage stories | `75009df` |
| 6 | Tickets, conversations, call transcripts (raw evidence only, C3) | `f881121` |
| 7 | Tasks, notes with templates and @mentions, notifications | `0d5b80a` |
| 8 | Account timeline from every M2 source with keyset paging | `f74ac46` |
| 9 | Inline edit through the service layer (Zod and audit) and the ARR tier rule | `cd96d1f` |
| 10 | Saved segments with a validated filter language | `4627d75` |
| 11 | Upload safety: content checks, workspace-scoped keys, guarded downloads | `2ac0153` |
| 12 | CSV import: mapping, dry-run preview, confirm, idempotent background runs | `71aee0d` |
| 13 | Missing-data helper: one question at a time, skippable, never blocking | `39917f4` |
| 14 | Data-quality checker with confirm-only fixes, including bulk | `2c258af` |
| 15 | M2 e2e, worker in e2e, a11y for M2 screens (plus the fixes these tests found) | `95215b5` |

New tenant models (all `[W]`, all with scopedDb access, RLS ENABLE + FORCE, workspace-safe composite FKs, registry coverage and read/update/delete/raw cross-tenant tests): Account, Contact, StakeholderRole, Contract, Subscription, Invoice, RevenueEvent, UsageDaily, UserUsageDaily, FeatureUsageDaily, FeatureCatalog, Conversation, Message, Ticket, CallTranscript, Task, NoteTemplate, Note, Notification, Segment, FileObject, ExternalRef, ImportJob, MissingDataPrompt, DataQualityIssue.

No AI in M2 (rule 8): no model call, no agent, no health score. AI-only columns (`Message.sentimentLabel`, `StakeholderRole.origin = AI`) are guarded by DB CHECKs that require an AgentRun id.

## Acceptance checklist (docs/milestones/M2.md §6)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | Final run after slice 15: typecheck, lint (plus secret check, 308 files), `Test Files 47 passed (47)`, `Tests 472 passed (472)`, build OK. Gate also green after each of the 15 slices. |
| 2 | `pnpm test:e2e` green for `e2e/m2-account360.spec.ts` | **PASS** | `20 passed, 12 skipped` (twice in a row: the spec holds on a re-seeded, never-reset DB). The 12 skips are the desktop-only flow tests on the mobile project (2 from M1 + 10 new), the same pattern as M1. |
| 3 | Tenant suite and model registry cover all new [W] models (Rule 2) | **PASS** | `tenant-isolation.int.test.ts` › "tenant isolation — M2 models (Rule 2)": one read/update/delete/raw case per model for all 25 models above, cross-tenant FK tests, AI-origin and sentiment CHECK tests. `model-registry.int.test.ts` fails if any Prisma model with `workspaceId` is missing from `TENANT_MODELS` or lacks RLS. |
| 4 | Every CSV template imports idempotently | **PASS** | `csv-import.int.test.ts` › "imports every template, and importing each file again creates nothing (idempotent)" (all 9 templates). Demo: contacts re-import showed **"0 created, 0 updated, 3 unchanged, 0 failed."** |
| 5 | Missing data shows plainly and never lowers anything (Rule 4) | **PASS** | Screenshot `m2-evidence/03-fairhaven-no-contract.jpg` ("No contract on file … Nothing is estimated in its place"). `tier-rule.test.ts` missing-ARR case (missing ARR never moves the tier). `missing-data.test.ts`/`.int.test.ts`. |
| 6 | Users without `canViewRevenue` cannot obtain money values through any action or route | **PASS** | `redact-financials.int.test.ts` (money keys removed, not zeroed; terms withheld; only revenue members record values); ARR sort falls back without revenue (D-42); ARR segment conditions need revenue (D-45); contract downloads need revenue. e2e as Tom Becker: "Restricted" shown, no `$` amounts on billing, no edit controls. |
| 7 | Contract terms and pricing notes encrypted at rest | **PASS** | Demo DB query: `SELECT left("termsEnc",12) … FROM "Contract"` → `k1.Bx_Nul_Bf…`, length 274, `LIKE '%Annual subscription%'` = false. `redact-financials.int.test.ts` › "stores terms and pricing notes as ciphertext" and the decrypt round trip. |
| 8 | Data-quality fixes only after confirmation, including bulk | **PASS** | `data-quality.test.ts` (8 detector cases) and `data-quality.int.test.ts` › "does not apply a fix without confirm: true", "bulk applies exactly the previewed list, skipping anything changed since the preview", "leaves out a fix whose record a merge in the same preview removes". e2e: Silverline merges only after Confirm. |
| 9 | No N+1 on Accounts list / Account 360 | **PASS** | `query-budget.int.test.ts`: Accounts page of 50 ≤ 4 queries, timeline ≤ 16 (measured constants, statements listed in the test). |
| 10 | Usage charts render only real rows; no placeholder data (Rule 6) | **PASS** | e2e: account imported from `accounts-clean.csv` (Foxglove Freight) → Usage tab shows "No usage data yet" and no chart in `main`. |
| 11 | Timeline shows all source types in order | **PASS** | `timeline.test.ts` (merge order and keyset paging) and `timeline.int.test.ts`. Screenshot `m2-evidence/02-brightwell-timeline.jpg`: usage change point, emails, note, call, task, ticket, newest first. |
| 12 | CSM sees own book by default; Viewer read-only | **PASS** | e2e as Leo Marsh: Brightwell visible, Pinecrest absent from search and a 404 by URL; Leo gets 404 on Settings › Import and › Data quality. e2e as Tom Becker: no inline edit controls. `accounts-list.int.test.ts` book-scope cases. |
| 13 | axe clean on Accounts, Account 360 (each tab), Import, Data quality at 1280 and 375 px | **PASS** | `e2e/a11y.spec.ts` › "axe: accounts, Account 360 tabs, import, data quality" passes on both projects (desktop 1280, mobile 375). It found one real issue on the first run (scrollable regions not keyboard-focusable at 375 px), now fixed. |
| 14 | Outside-signal CSV explicitly deferred to M3 | **PASS** | Deferrals below; D-47. |

### Kickoff rules (founder overrides) — how each was met

| Rule | Result | Evidence |
|---|---|---|
| Baseline first; M1 commits untouched | Met | Baseline before M2: gate 199 tests, e2e 8 passed / 2 skipped. History is linear on top of `53cc574`; no rewrite, amend or squash. |
| Native services only; no docker; #16 stays PARTIAL | Met | No docker command run. #16 carried forward below, as M1 left it. |
| Pinned versions; no upgrades | Met | Only additions: `csv-parse@7.0.3`, `file-type@22.1.1` (approved, pinned, D-46/D-47). |
| 1 Tenancy for every new [W] model, incl. raw client | Met | #3 above. |
| 2 Re-runnable CSV import | Met | Upload → mapping → preview with per-row report → confirm → result; nothing before confirm (dry-run test); no duplicates on re-import; audit rows per upload, confirm, chunk and completion (seen in the demo DB). |
| 3 Fixtures | Met | `fixtures/csv/` (9 clean templates, `accounts-malformed.csv` with bad dates, missing required fields, duplicate rows, unknown segment values; README). |
| 4 Upload safety | Met | `src/config/uploads.ts` (one allowlist, size from config); sanitised names; keys `ws/<workspaceId>/files/<uuid>` generated server-side; upload/download only via `/api/files` routes with membership and permission checks; `files.int.test.ts` cross-workspace download fails; rejected files never reach storage (tested). Demo: Ferngrove download → 404. |
| 5 Full seed | Met | Idempotent (seed test runs it twice); dates relative to SEED_TODAY; `.test` domains only (tested); Ferngrove has no Larkspur data (tested); M1 e2e still passes; demo users belong to Larkspur only (new guard test). |
| 6 Real screens | Met | Server-paginated list with search, filters and sort; Account 360 tabs are only those with data in M2 (no Health/Signals/Meetings placeholders); inline edits through services with Zod and audit. |
| 7 Missing data and data quality | Met | One question at a time, skippable (7 days, C2), never blocking; no health score; duplicates and conflicts create `DataQualityIssue` rows, never silent overwrites. |
| 8 No AI | Met | See "What was built". |
| 9 Audit and RBAC extend M1; CSM vs Admin tested | Met | `data:import` added to the matrix and its test; `inline-edit.int.test.ts` (CSM cannot change owner), `data-quality.int.test.ts` and e2e (CSM gets 404), `csv-import.int.test.ts` (CSM cannot import). |

## Regression statement

| | Baseline (before M2, at `53cc574`) | Final (at `95215b5`) |
|---|---|---|
| `pnpm gate` | green · 199 tests | green · 47 files · **472 tests** |
| `pnpm test:e2e` | 8 passed · 2 skipped | **20 passed · 12 skipped** |

Every M1 test still exists and still passes. M1-era test files changed in M2 only by additions, with one approved exception:

- **C1 (founder-approved): nav assertions only.** `e2e/m1-foundation.spec.ts` now asserts the main nav **exactly** equals what `features.ts` declares for the role (`navFor(role)` from `visibleNav`), instead of the hard-coded M1 list `["Home", "Settings"]` / `["Home"]`. `src/config/__tests__/features.test.ts` replaces the M1 exact lists with the M2 exact lists (Admin: Home, Accounts, Tasks, Settings; CSM and Viewer: Home, Accounts, Tasks; CS Leader: Home, Accounts, Tasks, Settings), and keeps a test that the M1-only nav is unchanged when only M1 has shipped. **Reason:** M2 ships Accounts and Tasks, so the hard-coded M1 lists would fail. The assertions stay exact-list matches, never "contains". Recorded in commit `ac133b5`.
- Additions only: `a11y.spec.ts` (+M2 screens), `seed.int.test.ts` (+M2 seed checks), `permissions.test.ts` (+`data:import` row), `model-registry.int.test.ts` (+agent-run CHECK), `tenant-isolation.int.test.ts` (+M2 models).

## Demo run (2026-11-02, fresh database)

Run on a brand-new database `nexaworks_m2demo` (created, granted with `docker/postgres/grants.sql`, `prisma migrate deploy` from empty: **11 migrations applied**, then the seed with the test tenant). The dev database was not reset (Prisma blocks AI-initiated resets, D-36), so a fresh database was the honest way to show a fresh migrate. The app and worker ran against it with `QUEUE_PREFIX=nexaworks-m2demo`.

1. **Accounts** (Priya, Admin): "Showing 1–50 of 72" (60 active, 12 churned) with Tier, Stage, Owner, ARR, Renewal and Last touch. `m2-evidence/01-accounts-list.jpg`.
2. **Story accounts:**
   - Healthy, **Marlow & Finch**: High-touch, $98k, champion Hugo Marlow active, usage up 30% against the previous four weeks.
   - At risk, **Halden Retail**: the same CSV-export ticket again, now open, high and escalated, plus angry inbound email.
   - Champion loss, **Brightwell Logistics**: Maya Ortiz "Former employee", status "Email bounced", usage down 37%, the mailer-daemon bounce and Leo's note on the timeline.
3. **Timeline:** Brightwell, every source type in order. `m2-evidence/02-brightwell-timeline.jpg`.
4. **CSV import with the fixtures:** `docs/samples/contacts-sample.csv` → preview "2 to create … 1 with problems", **"Row 4: email 'not-an-email' is not an email address."** (`04-import-preview-row-error.jpg`) → `fixtures/csv/contacts-sample-fixed.csv` → **"3 created, 0 updated, 0 unchanged, 0 failed."** → same file again → **"0 created, 0 updated, 3 unchanged, 0 failed."**
5. **Upload and authorised download:** Priya uploaded `brightwell-msa.txt` on Brightwell › Contracts & billing → `GET /api/files/<id>/download` → 200, `attachment; filename="brightwell-msa.txt"`, `nosniff`, exact bytes.
6. **Refused cross-workspace download:** signed in as Owen Hale (Ferngrove admin), the same URL → **404 "File not found."**
7. **Missing-data question answered:** Leo opened **Kestrel Robotics** → "When does this contract renew?" with Answer and "Skip for 7 days" (`05-kestrel-missing-data-question.jpg`) → answered 2027-04-01 → the question is gone after reload, and Contracts & billing shows **Apr 1, 2027**.
8. **Audit (demo DB):** `auth.signed_in`, `auth.signed_out`, `import.uploaded` ×3, `import.confirmed` ×2, `import.chunk`, `import.completed` ×2, `file.uploaded` ×4, `file.downloaded`, `contract.renewal_date_set`, `data_quality.scanned`, `seed.applied`.

Covered by e2e rather than by hand in this run: the Silverline merge, the segment save, the Pinecrest task and the @Aisha mention.

**Deviations from M2.md §7 (logged, approved where noted):**
- Step 5: M2.md has Priya answer Kestrel's renewal date. Kestrel's owner is Leo, and questions go to the owner (D-48, approved), so Leo answers it. Priya's question is Bluefin's missing owner (unowned, so it goes to an Admin), which e2e skips.
- Step 7: duplicates are at **Silverline Couriers**, not Halden Retail (founder-approved; SEED_DATA plants them there).

## Files changed (since `53cc574`, 182 files, +17.8k / −57)

- **Schema and data:** `prisma/schema.prisma`, 10 migrations (`m2_accounts_people` … `m2_data_quality`), `prisma/sql/rls.ts` (agent-run CHECK option).
- **Modules** (`src/modules/`): accounts (list, Account 360 data, tier rule, inline edit, timeline merge, missing data, data quality), contacts, billing, usage, support, conversations, tasks, notes, notifications, timeline, segments, files, imports; settings extended.
- **Routes:** `/accounts`, `/accounts/[id]/*` (9 tabs), `/tasks`, `/notifications`, `/settings/import`, `/settings/import/[id]`, `/settings/data-quality`; API `/api/files`, `/api/files/[id]/download`, `/api/imports`, `/api/imports/templates/[slug]`.
- **Components:** `src/components/app/` (11: line chart with data table, inline field, forms, uploads, import steps, missing-data card, segment save).
- **Lib and config:** `src/config/uploads.ts`, `src/lib/uploads/*`, `src/lib/format.ts`, permissions (`data:import`), features (Accounts, Tasks), env (`QUEUE_PREFIX`), queues, tenant registry, `src/test/query-counter.ts`.
- **Seed and fixtures:** `prisma/seed/demo/*` (roster, accounts, commercial, usage, conversations, work), 14 transcript fixtures and their generator, `fixtures/csv/*` (12 files), `docs/samples/contacts-sample.csv`.
- **Tests:** 25 new test files; e2e `m2-account360.spec.ts`; Playwright starts the worker.
- **Docs:** DECISIONS D-41 – D-51, QUESTIONS (Q-35; Q-09 superseded), ARCHITECTURE (modules, ImportJob), this log and `m2-evidence/`.

## Decisions added

- **D-41** Book scope TEAM = own plus unowned accounts.
- **D-42** Accounts list paging: opaque cursor over a deterministic order; no ARR sort without revenue access.
- **D-43** Transcript fixtures composed deterministically; last touch excludes tickets.
- **D-44** Timeline = source registry plus keyset merge.
- **D-45** Segment DSL.
- **D-46** Upload safety and the `data:import` permission (`file-type@22.1.1`).
- **D-47** CSV import strategy (`csv-parse@7.0.3`, pinned, its DECISIONS entry added at the end of M2 because slice 12 missed it; chunks of 200; ExternalRef dedupe with email fallback; outside-signal CSV to M3).
- **D-48** Missing-data rules. **C2: Skip snoozes for 7 days by default (a workspace setting). This supersedes Q-09's 30 days**, recorded in QUESTIONS.md and DECISIONS.md.
- **D-49** Data-quality checker: what is detected, the two confirm-only fixes, the bulk rule.
- **D-50** Calendar dates are stored at UTC midnight and shown in UTC.
- **D-51** `QUEUE_PREFIX`; e2e starts the worker.

## Questions added

- **Q-35** No team model exists for book scope TEAM. **Open, default in use:** own accounts plus the unowned pool (D-41); a real team model could come with Reports in M11.
- **Q-09** Superseded by founder decision C2 (7-day snooze, a workspace setting).

## Bugs found and fixed during M2 (by M2's own tests)

- **Calendar dates a day early** in US workspaces (a renewal answered as 2027-04-01 showed Mar 31, 2027). Fixed by D-50, with a unit test.
- **e2e imports never ran:** `next dev` always runs as development, so the app and the e2e worker used different queue prefixes. Fixed by D-51.
- **Test pollution (my slice-12 test):** `csv-import.int.test.ts` made the seeded users `leo@` and `aisha@larkspur.test` members of every throwaway test workspace, which showed up as extra workspaces in Leo's switcher during e2e. The app behaved correctly (membership grants switching), but the test was wrong. It now uses per-workspace owner users, a seed test guards that demo users are active only in Larkspur, and the 30 polluted memberships in the `_test` DB were **deactivated** (not deleted, to keep FKs). The dev DB was never affected.
- **Dismiss posted without the issue id:** React drops `name`/`value` on a button whose `formAction` is a function. The id is now bound to the action.
- **a11y at 375 px:** scrollable tables, import error lists and email bodies were not keyboard-focusable. Contract "Download" links now name their file.

## Deferrals (each with its target milestone)

- Outside-signal CSV import → **M3** (with the Signal model).
- Health filter in segments → **M3**.
- Lint rule requiring `${ctx.workspaceId}` in tagged `$queryRaw` → **M3** (D-40, carried).
- Extraction from transcripts and emails (promises, sentiment, stakeholder changes) → **M4 / M9**.
- `agentRunId` foreign keys on AI-origin columns → **M4** (the CHECKs are in place now).
- Account-merge fix in Data quality (M2 flags duplicate accounts for a person) → **M5**.
- Live connectors replacing CSV for CRM, billing, product usage, support and calls → **M5 / M6 / M9 / M10**.
- Meeting, Goal, Promise and OnboardingPlan records → their own milestones (C3: none in M2; raw evidence seeded instead).
- Production malware scanner (files stay PENDING in production until one is configured) → **M12** (Q-18).
- Production-build e2e → **M12** (D-37, carried).

## Carried from M1

- **#16 CLAUDE.md Commands section true — PARTIAL.** Each command was run once on 2026-11-02. **`docker compose up -d postgres redis minio` returned exit 127 (`docker` not installed).** Every other command passed. The fallback `pnpm services:native` was used, as approved. **Open follow-up:** install Docker, run the compose command, and record its output in M1-LOG. (Unchanged in M2; no docker command was attempted.)

## Known risks

- **Stale dev server after migrations or service edits:** `next dev` keeps serving an old Prisma client or module ("Cannot read properties of undefined (findMany)", "conversationTimeline is not a function", Kestrel wrongly showing "No contract"). Restart `pnpm dev` after a migration. Dev only; the gate and e2e start fresh processes.
- **Postgres 14 here vs 16 in compose** (D-31): nothing in M2 uses a 16-only feature.
- **e2e shares the `_test` DB with integration tests** and is never reset (D-36). The spec resets only what it needs (missing-data prompts) through a test helper and uses unique names for created records.
- **Production uploads stay PENDING** until a malware scanner is configured (D-46; M12).

## What M3 should know

- Health inputs exist as raw data only: usage aggregates and change points, tickets, conversations, contracts and revenue events, stakeholder roles with history. No score, no Signal rows.
- Register new timeline sources (signals, health) through the timeline registry (D-44). Add the health condition to the segment DSL behind the same schema (D-45).
- The CSV importer is template-driven (`src/modules/imports/templates.ts`): the outside-signal CSV is one new template plus a writer.
- Use `formatCalendarDate` for date-only fields (D-50).
