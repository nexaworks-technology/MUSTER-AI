# M3 log: Health Engine and Signal Engine (deterministic core)

**Date:** 2026-11-03 · **Result:** 14 of 15 M3 acceptance checks PASS outright; #4 PASS on what it checks, with its premise ("a seeded At Risk account") not true under the default model (Q-44, reported, not tuned). No check is FAIL or PARTIAL. M3 is complete, with Q-44 and Q-45 open for the founder.
**Carried from M1, unchanged:** M1 acceptance **#16 is PARTIAL** (Docker not installed; founder-approved, open follow-up). No docker command was run in M3.

## What was built

Eighteen planned slices plus two fix commits from the demo, one Conventional Commit each (`4cc3c92` … this log's commit), `pnpm gate` green before every commit, tests written first (golden fixtures before formulas).

| # | Slice | Commit |
|---|---|---|
| 1 | Raw-SQL lint rule (D-40 → D-60) with named permits; M3 decisions recorded | `4cc3c92` |
| 2 | Calendar-date helpers in the workspace time zone; point-in-time `Contact.statusChangedAt`, `Ticket.escalatedAt` | `f95dc5d` |
| 3 | HealthModel, HealthScoreSnapshot, HealthReason, CsmPulse, UsageBaseline with proof enforced by the database | `211f097` |
| 4 | Curves and every health component, golden fixtures first | `6b64a97` |
| 5 | Own-normal and cohort baselines, pure and in SQL | `868dca4` |
| 6 | Aggregation (renormalisation), risk reason, Pulse disagreement, `writeSnapshot` | `f18c3b8` |
| 7 | Point-in-time loader and `scoreAsOf`, with the leakage fixture | `69a2c0f` |
| 8 | Account 360 Health tab: the Why view with linked sources | `790b71f` |
| 9 | CSM Pulse with immediate re-score and visible disagreement | `7b1a4c6` |
| 10 | Signal, SignalRule and OutcomeRecord models with database guarantees | `c67508a` |
| 11 | 15 deterministic rule evaluators, 67 golden fixtures | `3ad0312` |
| 12 | Signal lifecycle (episodes, false alarm, materiality), outcomes, Signals screens and settings | `080c6d3` |
| 13 | Outside signals by hand and by CSV, always with a dated public source | `7b41ccc` |
| 14 | Nightly run through the real queue, real-time hook, `pnpm jobs:nightly` | `98d7009` |
| 15 | Health screen (bands, movers, disagreements); Health in the nav via `features.ts` | `de7980c` |
| 16 | Back-test, deterministic model proposal, versions, preview, activation | `5477579` |
| 17 | Seed v2 (decisions 1 and 7), seed back-test fixture, M3 e2e and a11y, and the fixes they found | `05702b0` |
| 17a | Fix: every proof link lands on its record; injectable clock in read paths (found in the demo) | `3b80425` |
| 17b | Fix: "1 person" wording; no stale back-test proposal offered (found in the demo) | `2fc51e1` |
| 18 | M3 log, plan, changelog, fresh-database demo evidence | this commit |

New tenant models (all `[W]`, RLS ENABLE + FORCE, workspace-safe composite FKs, registry coverage, cross-tenant tests): HealthModel, HealthScoreSnapshot, HealthReason, CsmPulse, UsageBaseline, SignalRule, Signal, OutcomeRecord. `Account.currentHealthSnapshotId` is a cache pointer with a composite FK to the account's own workspace.

**No AI in M3 (rule 1):** no model call, no agent, no prompt. `health-no-ai.test.ts` fails the build if anything under `src/modules/health` or `src/modules/signals` imports `src/lib/ai` (and proves the check catches one).

## Acceptance checklist (docs/milestones/M3.md §6)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | Final run (after `2fc51e1`): typecheck, lint (secret check, 476 files, no secrets), `Test Files 78 passed (78)`, `Tests 817 passed (817)`, build OK. Green before every M3 commit. |
| 2 | `pnpm test:e2e` green for `e2e/m3-health-signals.spec.ts` | **PASS** | Full suite `31 passed, 21 skipped`, **twice in a row** on the final code (re-seeded, never reset). The M3 spec's 9 flow tests run on desktop (skipped on mobile by design, like M2's). One earlier run failed only because the machine slept for 7 hours mid-run ("Test timeout of 60000ms exceeded"); it was re-run, not counted. |
| 3 | Tenant suite + registry cover the new models; nightly job is scoped (Rule 2) | **PASS** | `tenant-isolation-m3.int.test.ts` › "tenant isolation — M3 health and signal models (Rule 2)": read/update/delete/raw per model, plus composite-FK cases ("a Pulse cannot point at another workspace's account or member", "a snapshot cannot use another workspace's model or account", "an account's current snapshot cannot be another workspace's", "a baseline…", "a signal…", "an outcome cannot point at another workspace's signal"). `model-registry.int.test.ts` › "classifies every Prisma model exactly once". `pipeline.int.test.ts` › "a job built for workspace A cannot read or write workspace B (scoped by payload)". |
| 4 | Every pillar of a seeded At Risk account (Brightwell Logistics) opens reasons with clickable source records (Rule 1) | **PASS** on what it checks; premise differs (Q-44) | e2e › "Leo opens Brightwell's health: every pillar opens into reasons with sources": every EVIDENCE reason of Adoption, Engagement, Support, Relationship and Commercial has a source link; the usage source opens the Usage tab with that window highlighted; Relationship links Maya Ortiz's contact. **Brightwell is Watch (67.6), not At Risk**, under the approved formulas; not tuned (decision 8, D-59), Q-44 open for the founder. Screenshots `01-brightwell-why-adoption-relationship.jpg` (v1, Watch) and `07-brightwell-at-risk-under-v3.jpg`. |
| 5 | Missing data never lowers a score; null pillars show "Not enough data" (Rule 4) | **PASS** | `aggregate.test.ts` › "missing data never lowers a score: a no-data pillar equals the pillar not existing" and "renormalises the weights over the pillars that have data (worked example)". e2e: Brightwell's Sentiment shows "Not enough data" and "Its 10% weight is spread across the pillars that have data". Demo item 3. |
| 6 | DB refuses At Risk without reason and evidence reason without sources | **PASS** | `write-snapshot.int.test.ts` › "the database refuses a score without proof (M3 rule 2)": "rejects At Risk with no risk reason", "rejects a risk reason borrowed from another snapshot", "rejects an evidence reason with no source", "rejects a pillar score with no evidence reason", "rejects a missing-data note used as the risk reason", "keeps history immutable". |
| 7 | No LLM involved in any score | **PASS** | `health-no-ai.test.ts` › "health and signals use no AI" and "the check itself catches an AI import". |
| 8 | Back-test on seed history returns the expected fixture numbers; proposal deterministic | **PASS** | `backtest.test.ts` (math, search, determinism, ≥ 5/≥ 5 rule), `backtest.int.test.ts` (labels from data, DRAFT only, versions), and `backtest-seed.int.test.ts` › "matches the recorded fixture exactly, and twice in a row" against `fixtures/backtest-seed.json`. Seed numbers below. Demo item 5 and `04-backtest-proposal-v2.jpg`. |
| 9 | No look-ahead in `scoreAsOf` | **PASS** | `score-as-of.int.test.ts` › "gives the identical result and inputs after the post-date plants" (+ one case per leakage path: usage/replies, tickets/escalatedAt, invoices/failureCount, contact statusChangedAt, roles, tier rebuilt from ARR, Pulse, lifecycle/churnedAt never read) and "does see the plants when scoring as of a later date (the fixture is sensitive)". |
| 10 | Every rule has fire + not-fire golden fixtures; each rule shows the 4 spec fields | **PASS** | `rules.test.ts` › "every M3 rule has golden fixtures": 15 rules, 67 JSON fixtures in `src/modules/signals/__tests__/fixtures/<rule>/`. `rule-settings.int.test.ts` › "lists every rule with its four spec fields; CSMs cannot open it". `08-settings-signals-four-fields.jpg`. |
| 11 | Nightly run idempotent and chunked; no N+1 | **PASS** | `pipeline.int.test.ts` › "kickoff fans out to chunks…", "running it twice gives identical rows: no duplicate signals, no rewritten snapshots", "a failing chunk is retried without affecting the other chunks", "chunk queries do not grow with the number of accounts (no N+1)" (≤ 67 statements per chunk, measured). Demo below: the nightly job twice, zero changes the second time. |
| 12 | Pulse disagreement visible on /health | **PASS** | e2e › "Pulse: Tidewater already disagrees; Leo's Worried on a Healthy account joins the list". Ashgrove does not appear: its score is Healthy (Q-45). |
| 13 | Outside signals require dated public source | **PASS** | `outside.int.test.ts` › "refuse a missing or non-web source, a missing date, or a date in the future", "the database refuses an outside signal without its public source too", "imports from the outside-signal CSV template…". e2e › "Priya adds an outside signal for Northgate". |
| 14 | OutcomeRecord created when a ≥ WARN signal opens | **PASS** | M3.md names `outcome-created.int.test.ts`; the cases live in `lifecycle.int.test.ts` › "creates one outcome record for the episode, with ARR at the flag (never 0 when unknown)", "opens a new episode (and a new outcome) when it comes back", "an INFO signal creates no outcome record"; and `outside.int.test.ts` › "records a dated public event once, by a person, with its outcome record". |
| 15 | axe clean on /health, Health tab, /signals, Settings › Signals, Settings › Health model | **PASS** | `e2e/a11y-m3.spec.ts` › "axe: health, signals, health-model settings" on both projects (1280 px and 375 px), with every `<details>` opened so reasons and evidence are checked too. It is a new file: decision 3 allows no edit to the pre-M3 `a11y.spec.ts`. The portfolio list is at `/health/signals`. |

### Kickoff rules — how each was met

| Rule | Result | Evidence |
|---|---|---|
| 1 Deterministic only | Met | Acceptance #7. Health Analyst narrative deferred to M4. |
| 2 Every score carries its proof, enforced | Met | Acceptance #4 and #6: CHECK (At Risk ⇒ risk reason), deferred composite FK (the risk reason is the snapshot's own), deferred constraint triggers (every pillar with a value has an evidence reason with sources), immutable history. `sources.test.ts` › "covers every source type the engine emits" and "says plainly when a record no longer exists, instead of a dead link". |
| 3 Missing data excluded, never zero | Met | Acceptance #5; the Why view states the exclusion and where the weight went. |
| 4 Back-tests must not cheat | Met | Point-in-time loader + leakage fixture (#9); catch rate, mean and median lead (D-55), false-alarm rate and the per-account table on Settings › Health model; two runs identical (`backtest.int`, `backtest-seed.int`). Window and unscorable outcomes are listed. |
| 5 The proposed model is a search | Met | Simplex step 0.05 × 25 threshold pairs, 59,500 candidates; best and runner-up shown with plain-words pillar meanings; DRAFT only; activation by Admin only, audited (`health_model.activated`); edits previewed then saved as new versions; models frozen once they leave DRAFT (DB trigger); old snapshots keep their version (`backtest.int` › "only an Admin activates; the old version retires; old snapshots keep their version"). |
| 6 Cohorts | Met | `UsageBaseline` rows store the cohort key, size and value; the Why view shows "compared with N accounts like this one". `baselines.test.ts` › "identical raw usage scores differently when the cohort and own normal differ". |
| 7 Dates obey D-50 and the workspace time zone | Met | `dates.test.ts` in UTC, Asia/Kolkata and America/New_York; `pipeline.int` › "kickoff dates the run in each workspace's time zone…" (the 90-day window fires only in Kolkata at 2026-11-02T20:00Z); every service takes an injected clock; no test reads the real clock. |
| 8 Signals are records with a lifecycle | Met | `lifecycle.int.test.ts` (dedupe, episodes, resolve with reason, false alarm suppressed until materially worse, D-53); thresholds in Settings › Signals for Admin/CS Leader, Zod-checked, version-bumped, audited (`rule-settings.int`); e2e round-trips a threshold. |
| 9 Nightly job through the real queue | Met | BullMQ with the D-51 prefix, chunked, resumable by jobId (`ws.stage.asOf.runId.chunk`), tested through a real worker (`pipeline.int`); "Recompute now" and the seed use the same stage functions. |
| 10 CSM Pulse never a silent override | Met | Pulse is one component of Relationship; `overallExcludingPulse` and `riskLevelExcludingPulse` stored; disagreement listed on /health and spelled out on the Health tab ("Both are shown; neither replaces the other"). |
| 11 Tenancy, registry, permissions | Met | Acceptance #3; CSM sees own book (`health-overview.int` › "a CSM sees only their book, and no money without revenue access"); CSMs get 404 on Settings › Signals and › Health model (e2e). |
| 12 Nav grows by `features.ts` only | Met | `SHIPPED_MILESTONE = 3` adds Health (`/health`); `features.test.ts` per-milestone table (decision 3). |
| 13 Raw-SQL lint rule (D-40) | Met | `eslint-rules/raw-sql-workspace.mjs`; `lint-raw-sql.test.ts` with fixtures; permits named file by file (`src/lib/db/**`, `src/lib/auth/invitations.ts`, `src/lib/auth/identity.ts`, `src/lib/jobs/outbox.ts`, tests). No permit added after slice 1; the new `src/lib/db/locks.ts` falls under the existing `src/lib/db/**` permit. |

### Founder conditions A–F

- **A** Meeting rule dormant: `no_meeting_in_x_days` shows "Off — needs meeting data (arrives in M10)", cannot be enabled (`rule-settings.int` › "refuses to switch on a dormant rule"), produces no rows.
- **B** Same-day replacement only within the same model version (`write-snapshot.int` › "new inputs on the same day under the same model replace that day's snapshot", "another model version writes its own row…").
- **C** Full search runtime: 59,500 candidates in **0.46 s** (2.9 s including scoring the points) on the dev seed; 101 ms search / 1.7 s points on the test seed. Under 60 s, so no coarsening. Tests use step 0.1 or 0.25 where they only check behaviour.
- **D** Permits named file by file; none added later.
- **E** Outbox "nobody.listens" warnings left alone.
- **F** Everything else as planned.

## Regression statement

| | Baseline (before M3, at `6c1093b`) | Final (at `2fc51e1`) |
|---|---|---|
| `pnpm gate` | green · 47 files · 472 tests | green · 78 files · **817 tests** |
| `pnpm test:e2e` | 20 passed · 12 skipped | **31 passed · 21 skipped** (twice) |

Every pre-M3 test still exists and passes. **Pre-M3 test-file diff (`git diff 6c1093b` over test files that existed at `6c1093b`): only `src/config/__tests__/features.test.ts` changed**, under decision 3 (approved 2026-11-02: it became a per-milestone table with exact M1, M2 and M3 rows; the M1 and M2 rows are unchanged). `prisma/seed/__tests__/seed.int.test.ts` is byte-identical (decision 7). New M3 tests are in new files only. Test infrastructure that is not a test file also changed: `vitest.config.ts` (the `demo-seed` project, D-68) and `src/test/db-env.ts` (a per-process connection-pool cap); neither changes an assertion.

## Seed v2 and the seed back-test (decisions 1, 7, 8)

- **Seed corrections (decision 1, D-52/Q-36):** churned accounts get one 2-year contract ending at churn; active accounts outside the documented renewal set get one 2- or 3-year contract, so the data-derived renewals are **exactly SEED_DATA §8's 12** (tested); every active contract renews within 12 months (tested); revenue-event counts unchanged (M2 seed test, unmodified, passes).
- **Missing plants (decision 7, D-58):** two champion-left churns (champion role ends 50 days before churn, contact LEFT), and the "renewed; temporary dip" account becomes a migration support spike (6 tickets 52–47 days before renewal). Seed-only.
- **Pulses and the outside signal:** Tidewater WORRIED by Leo ("New VP is skeptical"), Ashgrove FINE by Aisha ("Spike was one migration, resolved"); Brightwell "Acquired by Haverford Group" (ACQUISITION, public source dated 2026-10-20, imported by Priya). Then the nightly pipeline runs for SEED_TODAY.
- **Back-test window:** 2024-11-01 to 2026-11-02 (24 months). 12 churns, 12 renewals, **no unscorable outcomes**.
- **Default model (v1):** "With this model, we would have flagged **0 of your last 12 churns**, with 0 false alarms out of 12 renewals." SEED_DATA §8 expects "≈ 8 of 12"; the actual number is reported beside it and nothing was tuned (decision 8, D-59). The lowest score any churned account reached in its last 120 days ranged 67.6–100.
- **Proposal:** Adoption 70 %, Engagement 5 %, Support 5 %, Relationship 5 %, Commercial 5 %, Sentiment 10 % (kept: no data), Healthy from 60, Watch from 55. "With this model, we would have flagged **4 of your last 12 churns, on average 28 days early, with 0 false alarms out of 12 renewals**." (median 28). Caught: Northway Logistics 28 days, Junipermark Retail 35, Crescentline Care Partners 28, Coastalgate Retail 21. The runner-up scores the same. Recorded in `src/modules/health/__tests__/fixtures/backtest-seed.json`.
- **Seed health today (default model):** 57 Healthy, 3 Watch (Brightwell 67.6, Cobalt Ridge 69.1, Saltmarsh 60.8), **0 At Risk**, 0 not enough data.

## Problems found by the slice-17/18 tests and the demo, and their fixes

1. **Preview then save saved the un-edited weights (D-70).** React 19 resets an uncontrolled `<form action>` after each action, so "Preview back-test" put the edit form back to its starting weights and "Save as a new version" saved those. Found because the e2e's "restored default" versions carried the proposal's weights. Fixed with controlled inputs; the e2e now checks the active version shows the typed weights (Adoption 30 %, Relationship 20 %). The `_test` database's health model was put back to the default weights through the service path (save + activate as Priya, v7), since the seed scores with whatever is active.
2. **Overlapping re-score runs failed on the unique key (D-69).** An activation queued a re-score while another run was scoring the same account, model and day; the second insert failed. `writeSnapshot` now locks the account row first. New case: `write-snapshot.int` › "concurrent writers for the same account, model and day all succeed and leave one row" (failed before the fix, passes after).
3. **Seed tests collided (D-68).** Three test files re-seeding one demo workspace in parallel tripped unique keys and the pre-M3 seed test's 30 s timeout. `runSeed` now holds a database advisory lock, and seed-reading files run last, one at a time (vitest project `demo-seed`). No timeout or check was loosened.
4. **The back-test fixture test read the active model** (which e2e changes on the shared `_test` database). It now reads the default model (v1) explicitly.
5. **Proof links that did not land on their record (D-71), found by following every link in the fresh-database demo.** The usage source for "36 of 207 seats were used in the last 28 days (Oct 5 – Nov 1)" opened a page that said 35 (28 days to today); a champion's last message was a ticket reply, linked to a Conversations anchor that was on no page; ARR-change windows linked to `#arr-movements`, which no page renders. Fixed (window-aware Usage tab, `conversationPageFor` + ticket routing, `#revenue`), with `usage-window.int.test.ts`, `message-link.int.test.ts`, two corrected `sources.test.ts` expectations (they named the wrong anchors), and an e2e that follows every source and evidence link on Brightwell and fails on the old code.
6. **Real clock in read paths (D-72).** Pulse "valid" on screen used `new Date()`, so `pulse.int.test.ts` would have flipped about 30 days after its fixed date; outcomes of escalating live signals were dated with `new Date()`. Both now use the injected clock.
7. **Intermittent pipeline query-budget failure (D-72).** Prisma's query events arrive asynchronously, so a run's last parallel loader reads were sometimes counted in the next run (two = 69 vs five = 67, a different table set each time). The test now waits for them before closing each count; 5 of 5 combined runs pass, against about 1 in 2 failing before. The budget (≤ 67, equal for 2 and 5 accounts) is unchanged.

## Test and fixture corrections (expected values changed before the code existed)

Each was a wrong expectation in a fixture written test-first, corrected with the reason before or while implementing; none was changed to make failing code pass.

| Fixture / test | Was | Now | Why |
|---|---|---|---|
| `baselines.test.ts` young history | 20 days | 21 | Miscounted: a 34-day series has 21 days inside the baseline window. |
| `baselines.test.ts` short series | 4 | 5 | Miscounted: an 18-day series has 5 days inside the window. |
| `baselines.test.ts` cohort fallback | a tier+band level | drop use case → drop company size → drop plan (tier only) | The fixture expected a level the documented stepwise fallback does not have. |
| `baselines.test.ts` big-account cohort score | 0 | 2.92 | A ratio of 0.125 is just above the curve's zero point (0.1): small, not 0. |
| `components.test.ts` invoice wording | "All 1 invoices …" | "All invoices in the last 90 days were paid on time (1)." | Wording only: "All 1 invoices" read badly. |
| `backtest.test.ts` search | proposal changes weights | keeps default weights, Watch from 55 | Thresholds are searched too (ARCHITECTURE §4.5); the tie-break keeps the weights nearest the default. |
| `score-as-of.int.test.ts` Pulse expiry | earlier date | Nov 20 | The planted Pulse must still be valid at the later date the case compares against, or "ignored" could not be told from "expired". |
| `outside.int.test.ts` import error | the column key | "/public source link is required/" | The test checked the column key; the import reports the plain-words label ("Row 3: public source link is required."). |
| `pulse.int.test.ts` CSM outside book | ForbiddenError | AccountNotFoundError | Out-of-book accounts are not revealed to exist (M2 convention, 404). |
| `lifecycle.int.test.ts` outbox counts | global | scoped to the workspace | Other tests write outbox rows in parallel. |
| `health-overview.int.test.ts` Pulse | fake id | a real `CsmPulse` row | The snapshot's `pulseId` has an FK. |
| `sources.test.ts` ARR-change window and message links | `#arr-movements`; `conversations#message-m1` | `#revenue`; `conversations?message=m1#message-m1` (+ a new ticket-reply case) | The expected hrefs were wrong: no page renders `#arr-movements`, and a message on a later Conversations page was unreachable. Found in the demo (D-71). |
| e2e status messages after false alarm / activation | transient "status" text | the lasting outcome | The control holding the message unmounts once the signal is no longer live / the model is active; the page shows the outcome instead ("Marked false alarm", "False alarm: …", "Active: vN"). |

## Decisions and questions

- New decisions: D-52 … D-70 (`docs/DECISIONS.md`). Defaults chosen and why: D-63 (weights 30/15/15/20/10/10, thresholds 70/45, curves per component, Pulse 30 % of Relationship, 30-day validity).
- Answered this milestone: Q-36 … Q-43 (founder decisions 1–8).
- **Open for the founder:**
  - **Q-44:** Brightwell scores Watch (67.6), not At Risk, under the approved formulas; no seeded account is At Risk. Options: accept the default (the back-test proposal catches 4 of 12), activate the proposal, or change formulas.
  - **Q-45:** Ashgrove's closed, un-escalated migration spike does not lower Support under the spec's inputs, so its Pulse agrees with its score. Options: add a "ticket volume vs normal" Support component (spec change), or wait for M9 repeat-problem detection.
  - Q-35 (TEAM book scope) remains open from M2.

## Deferrals

- Text signals (repeat problem, angry sentiment, export/cancel language, ticket sentiment) → **M9**.
- Adoption stall / onboarding signals → **M6**.
- Money limit / new team signals → **M7**.
- Health Analyst narrative over reasons and signals → **M4**.
- OutcomeRecord checkpoints and `actionTaken` → **M4/M7/M11**.
- Meeting rule (dormant) and the Engagement meeting component → **M10**.
- Back-test snapshots are computed in memory, not written as `isBacktest` rows (D-67) → revisit when a report needs them.

## Known risks

- **Back-test sensitivity to small history:** 12 + 12 outcomes; one account moves the catch rate by 8 points. The proposal is shown with its window, per-account table and runner-up, and never self-activates.
- **Default model is cautious on the seed:** 0 of 12 churns flagged; a single collapsed pillar is diluted by clean ones (Q-44).
- **Nightly duration:** about 1.0–1.4 s per pass for 60 accounts; chunk queries are constant per chunk (no N+1), so it scales linearly with chunks.
- **Dev only:** run the gate with the dev server stopped (Postgres 14 native, `max_connections` 100; tests cap their pool at 5); restart `pnpm dev` after a migration (stale Prisma client).

## Demo run (fresh database)

Run on a brand-new database `nexaworks_m3demo` (created and granted with `docker/postgres/grants.sql`, `prisma migrate deploy` from empty: **16 migrations applied in 1 s**, then the seed with the test tenant in **13 s**, which includes the nightly pipeline for SEED_TODAY). The app and worker ran against it with `QUEUE_PREFIX=nexaworks-m3demo`; the dev and `_test` databases were not touched. Workspace time zone America/New_York, so the demo's "today" was Nov 2, 2026 throughout. Screenshots in `docs/milestones/m3-evidence/`.

1. **Scoring.** After the seed: 60 snapshots for the 60 active accounts at Nov 2, 2026 (model v1, default weights), 36 signals, 28 outcome records, 0 duplicate signal keys. Bands: 57 Healthy, 3 Watch (Brightwell 67.6, Cobalt Ridge 69.1, Saltmarsh 60.8), **0 At Risk** (Q-44).
2. **Health screen** (Leo, CSM, own book of 16): 0 At Risk · 2 Watch · 14 Healthy · 0 Not enough data; ARR "Restricted" (no revenue access); "Score and CSM disagree (1)": Tidewater, "The numbers say Healthy (92); Leo Marsh says Worried: 'New VP is skeptical'". `02-health-screen-leo.jpg`.
3. **Brightwell's Why view** (Leo): 68 Watch under v1. Adoption 46 (main input: "Typical weekday active users fell from 40 to 20.4 (−49%) against this account's normal (Jul 21 – Oct 19, 2026)", value 20.4 · baseline 40 · impact −6.9 pts; "10% of 207 seats active … against 31% for 9 High-touch accounts"); Relationship 61 ("Champion Maya Ortiz: email bounced (Oct 27, 2026)", linked to her contact and role); Sentiment "Not enough data", its 10 % weight spread over the others. The usage source opened the Usage tab with Oct 26 – Nov 1 shaded. Every source and evidence link on the Health and Signals tabs was followed: after the D-71 fixes all 26 land on their record (before: 2 dead anchors and one window that showed 35 instead of the reason's 36). `01-brightwell-why-adoption-relationship.jpg`.
4. **Halden and Marlow & Finch.** Halden Retail: **93 Healthy**; Support 69 ("1 high or urgent ticket is open", "Oldest open ticket 'CSV export fails at month-end' (high) has been open 4 days; the target is 5", "1 ticket was escalated in the last 30 days"); signal "Escalated ticket: CSV export fails at month-end" (Warning). Its repeat problem, angry email and late promise need M9/M10 text analysis, so it is not At Risk in M3 (reported, not tuned). Marlow & Finch: **97 Healthy**, all parts 93–100, as SEED_DATA describes.
5. **Back-test run twice** (Priya, Admin): both runs (v2 at 11:12 PM, v3 at 11:13 PM) say "With this model, we would have flagged **4 of your last 12 churns, on average 28 days early, with 0 false alarms out of 12 renewals**", the active v1 "0 of your last 12 churns, with 0 false alarms out of 12 renewals", window Nov 1, 2024 – Nov 2, 2026, 59,500 combinations. Compared field by field in the database: weights, thresholds, curves, result, runner-up, baseline and window **identical**; only the timings differ (search 137 / 112 ms, points 1,462 / 1,284 ms). Matches `backtest-seed.json`. `04-backtest-proposal-v2.jpg`.
6. **Weight change previewed, saved as a new version, old snapshots unchanged.** From v3: Adoption 50, Engagement 15, Support 10, Relationship 10, Commercial 5, Sentiment 10, Healthy from 65, Watch from 50 → Preview: "flagged 0 of your last 12 churns … · not saved" (the inputs kept the typed values after Preview, D-70) → Save: "Saved as draft v4. Nothing changes until an Admin activates it." (`health_model.edited`). Then Priya approved and activated the proposal v3 (M3.md step 10): "Active: v3 · Proposed by back-test … approved by Priya Raman", v1 Retired; audit `health_model.activated` (USER, "Activated health model v3 (replaces v1)"). The activation re-scored all 60 accounts as **new v3 rows**; the **60 v1 snapshots and their 1,650 reasons are byte-identical** before and after (checksum `177268027f4c4a4e` both times). Under v3: 5 At Risk (Brightwell 54, Cobalt Ridge 50, Pinecrest 40, Redfern 45, Saltmarsh 37), 0 Watch, 55 Healthy; Brightwell's main reason is the usage drop. `05-weight-edit-preview.jpg`, `06-v3-activated.jpg`, `07-brightwell-at-risk-under-v3.jpg`.
7. **A disagreeing Pulse.** Leo on Marlow & Finch: "Worried", "QBR slipped twice; sponsor hard to reach" → re-scored at once to 92 (97 without the Pulse), "Score and CSM disagree", "The numbers say Healthy (97 without the Pulse); Leo Marsh says Worried. Both are shown; neither replaces the other." → it joined /health's list next to Tidewater. `03-marlow-finch-pulse-disagreement.jpg`.
8. **Nightly job twice, zero duplicates.** `pnpm jobs:nightly --workspace larkspur-demo` right after the seed, twice: "60 accounts in 1 chunk(s), 1352 ms / 1207 ms; signals: 0 opened, 0 updated, 0 resolved; health: 0 new snapshots, 0 replaced, 60 unchanged, 0 band changes". Twice again after the demo's changes: "0 opened, 0 updated, 0 resolved, 1 kept quiet (false alarms); 60 unchanged" (1089 / 1028 ms). Database check: 0 signal keys with more than one row per episode.

Also shown (M3.md §7): Sundial Fitness → "Payment failed: invoice LRK-1075" (Critical), invoice linked; Leo marked Brightwell's "Only 36 of 207 seats in use" a false alarm ("Seats pre-bought for the Q1 rollout to two more depots") → it left the live list (17 live signals in his book) and stayed quiet through the next nightly runs; Priya added "Northgate names a new COO" (leadership change, https://news.example.test/northgate-new-coo, Oct 29, 2026) → on Northgate's Signals tab as "New · Oct 29, 2026" with its public source. Settings › Signals with the four spec fields: `08-settings-signals-four-fields.jpg`.

**Deviations from M3.md §7 (reported, not tuned):** step 2 (Brightwell is Watch, not At Risk, under the default model; At Risk under the activated back-test proposal; Q-44); step 8 (Ashgrove's Pulse agrees with its Healthy score; Q-45; the disagreement is shown with Tidewater and a Pulse set live); step 1 uses `--workspace larkspur-demo` (the slug), not `larkspur`.

**Found and fixed during the demo:** the proof-link gaps (D-71, item 3); "1 people used the product" now reads "1 person" (the next nightly run updated the 2 affected signals in place); Settings › Health model no longer offers a back-test draft made before the active model went live (it compared itself with a model that is no longer active; it stays under "All versions").

## Files changed

215 files against `6c1093b` (175 added, 40 modified), including 67 golden rule fixtures, 5 lint fixtures and 8 evidence screenshots.

- **Schema and migrations:** `prisma/schema.prisma`; `prisma/migrations/…_m3_point_in_time`, `…_m3_health`, `…_m3_ticket_priority_history`, `…_m3_signals`, `…_m3_outside_signals_import`.
- **Health module (new):** `src/modules/health/` — `engine/` (curves, model, types, format, windows, baselines, aggregate, backtest, index, `components/` adoption, engagement, support, relationship, commercial, people, index), `loader.ts`, `baselines-sql.ts`, `snapshots.ts`, `sources.ts`, `service.ts`, `backtest-service.ts`, `actions/pulse.ts`, `actions/model.ts`, 16 test files + `fixtures/backtest-seed.json`.
- **Signals module (new):** `src/modules/signals/` — `rules/catalog.ts`, `rules/index.ts`, `rule-rows.ts`, `lifecycle.ts`, `outside.ts`, `pipeline.ts`, `schemas.ts`, `service.ts`, `actions/signals.ts`, 7 test files + `fixtures/<rule>/*.json` (67).
- **Shared libraries:** `src/lib/dates/` (new, + tests), `src/lib/db/locks.ts` (new, + test), `src/lib/db/tenantModels.ts`, `src/lib/db/workspace.ts`, `src/lib/jobs/outbox.ts`, `src/lib/db/__tests__/tenant-isolation-m3.int.test.ts` (new).
- **Other modules:** accounts (`service.ts`, `schemas.ts`), segments (`dsl.ts`, `service.ts`), imports (`templates.ts`, `writers.ts`, `service.ts`), usage (`service.ts`, + `usage-window.int.test.ts`), conversations (`service.ts`, + `message-link.int.test.ts`), contacts (`point-in-time.int.test.ts`, new).
- **Worker and scripts:** `src/worker/processors.ts`, `src/worker/index.ts`, `scripts/jobs-nightly.ts`, `package.json` (`jobs:nightly`).
- **Screens:** `src/app/(app)/health/page.tsx`, `health/signals/page.tsx`, `accounts/[id]/health/page.tsx`, `accounts/[id]/signals/page.tsx`, `settings/signals/page.tsx`, `settings/health-model/page.tsx` (new); `accounts/page.tsx`, `accounts/[id]/layout.tsx`, `…/people`, `…/tickets`, `…/billing`, `…/conversations`, `…/usage` pages, `settings/access.ts`; components `risk-badge`, `pulse-controls`, `signal-list`, `signal-actions`, `rule-settings-form`, `outside-signal-form`, `recompute-button`, `model-controls` (new), `line-chart`.
- **Config, lint, tests infrastructure:** `src/config/features.ts`, `src/config/__tests__/features.test.ts` (decision 3), `eslint-rules/raw-sql-workspace.mjs`, `eslint.config.mjs`, `src/lib/__tests__/lint-raw-sql.test.ts` + fixtures, `vitest.config.ts` (D-68), `src/test/db-env.ts` (per-process pool cap).
- **Seed:** `prisma/seed/run.ts`, `demo/roster.ts`, `demo/commercial.ts`, `demo/conversations.ts`, `demo/accounts.ts`, `demo/health.ts` (new), `__tests__/seed-health.int.test.ts` (new).
- **E2E:** `e2e/m3-health-signals.spec.ts`, `e2e/a11y-m3.spec.ts`, `e2e/support/signals.ts`, `e2e/support/axe.ts` (all new).
- **Fixtures and docs:** `fixtures/csv/outside-signals-clean.csv`, `fixtures/csv/README.md`; `docs/DECISIONS.md` (D-52 … D-72), `docs/QUESTIONS.md` (Q-36 … Q-45), `docs/IMPLEMENTATION_PLAN.md`, `docs/milestones/M3-LOG.md`, `docs/milestones/m3-evidence/`, `CHANGELOG.md`, `CLAUDE.md` (Commands: `jobs:nightly`).

## What M4 should know

- **Events emitted** to the outbox (awaiting a consumer, D-66): `signal.opened`, `signal.resolved`, `health.bandChanged`.
- **OutcomeRecord rows** exist for every WARN+ RISK/OPPORTUNITY episode with `actionTaken = PENDING` and `arrAtFlagMinor`; M4/M7/M11 fill checkpoints.
- **Citation targets for the Health Analyst:** `HealthReason.id` (with `sources[]`, value, baseline, cohort, period) and `Signal.id` (with evidence and the rule's four fields). Explain only what these say; never a number they do not contain.
- **Sentiment is null** until extraction exists (M4/M9); Engagement's meeting component is null until M10.
- Scoring entry points: `scoreAsOf` (pure, point-in-time), `scoreAndStore`, `recomputeAccounts`; `writeSnapshot` is the only insert path.
