# M11 log — Ask AI, Reports & Outcome Ledger

> **Session 1 (S1–S7) — DRAFT, written at the end of Session 1 (2026-11-05).** Session 2 (S8–S13: Ask AI tools, approval executors, Ask agent, file Q&A, voice/nav, seed + e2e, close) appends its own sections. Plan: `/Users/sahil/.claude/plans/distributed-weaving-glacier.md`. Founder decisions D1–D11 approved at the recommended defaults with conditions on D3, D5 and D6 (recorded as D-158..D-168, Q-16 answer, Q-83, Q-84).

Baseline: `9777818` (M10 close: 256 files / 2,386 tests). Services via `pnpm services:native`; Docker untouched (#16 stays PARTIAL). No `ANTHROPIC_API_KEY`: agent behaviour proven on recorded transports only.

---

## Session 1 — What was built

| Slice | Model | Commit | What it is | Evidence |
|---|---|---|---|---|
| Decisions | Opus | `ead64ac` (docs) | D-158..D-168; Q-16 founder answer (outcome-based alarms, supersedes "CSM agreed"); Q-83 (agent roster 15 vs §6.2's 14); Q-84 (d7 raw-ms due date). | `docs/DECISIONS.md`, `docs/QUESTIONS.md` |
| S1 Schema & tenancy | Sonnet | `ead64ac` | `ReportSnapshot` (immutable by trigger `report_snapshot_immutable`; `digestAgentRunId` NULL→value once), `AskThread`, `AskMessage` (CHECK `ask_message_agent_run_required`), `FilePurpose.ASK_ATTACHMENT`, trigger `outcome_checkpoint_frozen` (d30/d90/isTrueAlarm only NULL→value). Migration `20261109100000_m11_reports_ask_outcomes`, RLS + composite FKs; `TENANT_MODELS` 74→77. D-158: `liveSnapshotWhere()`; the two unfiltered readers (`qbr/service.ts`, `meeting-qbr.ts`) fixed. | `tenant-isolation-m11.int.test.ts` + `model-registry.int.test.ts` + `live.test.ts` (181/181); `qbr` 13/13; `meeting` 6/6 |
| S2 Checkpoints | **Opus** | `faeb050` | `outcomes/checkpoints.ts` (pure): all 8 statuses, precedence CHURNED > CONTRACTED > RENEWED/EXPANDED > RECOVERED (held 14 days) > MEETING_HELD > REPLIED > NO_CHANGE; both sides cited (flag + health at flag / outcome evidence); workspace business dates + 7-day grace; `classifyAlarm()` (D-163). `revenueStatusOf()` now shared with M7's revenue checkpoint (one definition). `checkpoints.service.ts` stores each once with an audit row, joins the existing `outcomes.checkpoint` job. Seed module `prisma/seed/demo/m11.ts` (D-166, raw flags + actions only) and `pnpm outcomes:backfill`. | RED `m11-evidence/s2-red.txt`; `checkpoints.test.ts` 21/21; `checkpoints.int.test.ts` 6/6; M7 `checkpoint-revenue.int.test.ts` unchanged and green |
| S3 Ledger math | Sonnet | `716e17c` | `outcomes/ledger.ts` (pure): cohort = RISK flags whose d90 fell due in the period; awaiting counted separately; saved = ACTED and RECOVERED/RENEWED at d90, $ = ARR at flag per currency (D-162); groups per account/play/agent/rule; RESTRICTED money without revenue permission; plain-words definitions for both saved figures. `ledger.service.ts` book-scoped loaders. | RED `m11-evidence/s3-red.txt`; `ledger.test.ts` 15 + `ledger.int.test.ts` 6 (reconciliation, M7 agreement, book scope, tenant, query budget) |
| S4 Ledger UI | Sonnet | `789859b` | `/reports/outcomes` (computed headline sentence, "attributed, not proven causal", definition beside money, period filter, per-group tables, every count opens its records), save record `/reports/outcomes/[id]` (signal → actions → d7/d30/d90 evidence), Account 360 "Outcomes" tab, play "Results" link. | browser check below; query budgets in `ledger.int.test.ts` |
| S5 AI accuracy | Sonnet | `5559be1`, fix `247654d` | `outcomes/accuracy.ts` (pure): true/false/undetermined per agent and rule through `classifyAlarm()`, false-alarm rate and CSM acceptance (null, never 0), cries wolf (D-167). `/reports/ai-accuracy` with exact-records drill-down; Tune/Kill only for `healthModel:propose` via the audited `updateRuleSettings`. **Fix found in the browser:** the window was by flagged date, which can never contain a determined alarm (outcomes need 90 days) — now judged by 90-day check date, like the ledger; D-167 updated. | RED `m11-evidence/s5-red.txt`; `accuracy.test.ts` 12 + `accuracy.int.test.ts` 7 (Tune/Kill audit rows, CSM refused, tenant, book scope, query budget, never reads snapshots) |
| S6 Reports | Sonnet | `c23c630` | Seven pure report computations on the screens' own functions; `generateReport()` stores an audited, immutable `ReportSnapshot`; filters period/owner/tier/segment; CSM book scope server-side; money redacted at read time; `/reports`, `/reports/[reportKey]`. | RED `m11-evidence/s6-red.txt` (7 sections); `pnpm test src/modules/reports` 56/56 incl. parity vs `healthOverview`, `listRenewals` forecast, `getAdoption`; D-158 back-test exclusion; 2-vs-5 query budgets |
| S7 Leader Reporter | Sonnet | `ac60774` | Agent `leader-reporter` (prompt 1.0.0, standard) writes only from non-money figures of four SCHEDULED snapshots (D-169); citations + numbers rule unchanged incl. dates (D-164). `reports.weeklyDigest` Mon 07:00 workspace tz registered inside `syncNightlySchedules` (no new scheduler), dedupe-intended id per business week; in-app + staff email + Slack DM to Admin/CS Leader only; failure → no AI text, honest notice (D-170). `/reports/digest`, `pnpm reports:digest`. NotificationType migration `20261110100000_m11_leader_digest`. | `leader-reporter.test.ts` 8; `digest.int.test.ts` 11; `leader-digest.int.test.ts` 2; recorded-transport demo run DELIVERED |
| Registry fix | Opus | `d9931bc` | Agent registry built on first use (import-cycle safe) — see batch 1 below. | 5 suites 31/31 |

---

## Session 1 — The one mid-milestone full `pnpm test`

Run once after S7 (nothing edited during the run), 343 s.

| Run | Test files | Tests | Result |
|---|---|---|---|
| M10 close baseline | 256 | 2,386 | green |
| M11 mid-run | 275 | 2,531 | **5 files failed to load**, 270 files / 2,531 tests passed |
| Batch 1 re-run (failed suites only) | 5 | 31 | **all passed** |

**Failure read together (batch 1 of 2):** all five (`adoption-coach`, `digital-csm`, `onboarding-manager`, `renewal-manager`, `voice-samples` `.int.test.ts`) failed at import with `TypeError: Cannot read properties of undefined (reading 'key')` at `agents/registry.ts`. Cause in this milestone's code: the registry built its map eagerly at import, and after S7 a circular load reached from a definition module read a definition before its module finished loading. I did not isolate the exact new edge S7 added. Fix (`d9931bc`): build the map on first use, which changes no behaviour. Re-run of the 5 failed suites: 31/31.

---

## Session 1 — Pre-M11 test changes (standing pre-approval; every one logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/agents/__tests__/team.int.test.ts` | sorted agent keys, 13 | + `"leader-reporter"`, 14 | S7 registers the Leader Reporter (`M11_AGENTS`); founder pre-approved 13→15 across both sessions | registry |

No other pre-M11 test file was changed. `model-registry.int.test.ts` has no count constant (77 models are checked by enumeration).

---

## Session 1 — D9 seed-baseline proof

The founder required that the M11 seed module leave seeded health scores, bands and renewal confidences unchanged.

- Before: the dev DB as left by the M10 seed. All 60 seeded accounts' current snapshot (overall + 6 pillars + band) and all Renewal rows (date, confidence, band, stage) were dumped to `docs/milestones/m11-evidence/seed-baseline-before.txt` (120 rows).
- `pnpm db:seed` then ran with `seedM11` (writes historical flags, tasks and OutcomeRecords, then runs the real checkpoint code).
- After: the same dump in `seed-baseline-after.txt`.
- **`diff` reports no differences (120/120 rows identical).** A second `pnpm outcomes:backfill` stored nothing new, so it is idempotent.

What the real checkpoint code computed from the seeded history (larkspur-demo):
- RISK flags at d90: 8 CHURNED (all true alarms; 4 acted on, 4 ignored), 3 CONTRACTED (true), 1 NO_CHANGE marked FALSE_ALARM (the migration spike, a false alarm), and 1 NO_CHANGE undetermined (the seasonal dip).
- One RISK flag is still awaiting d90.
- OPPORTUNITY flags: 4 EXPANDED (2 acted on).
- The 3 silent churns were never flagged. That miss is part of the record.

---

## Session 1 — Browser check of new screens (dev server, dev DB)

- `/reports/outcomes` as **Dana** (CS Leader, revenue): 365-day view, "Of 13 risks that reached their 90-day checkpoint … acted on 7; 0 recovered or renewed", labelled "attributed, not proven causal", with the definition beside money. The opportunity line shows "worth $15,200.00".
- The same page as **Leo** (CSM, no revenue): book-scoped to 5 risks, and every money figure reads "Restricted".
- `/reports/ai-accuracy`: definitions and tables render. This is where the window flaw was found and fixed (`247654d`).
- `/reports` and `/reports/portfolio-health-trend`: Generate stored a snapshot showing 5 At Risk and 55 Healthy, ARR at risk $265,600, and each figure lists its source records. Weekly points before the seed date say "No health history before this date" rather than guessing.
- `/reports/digest`: four cited sentences from the recorded run and no money.
- No console errors and no server errors.
- Screenshots of the Dana vs Leo ledger were taken in the session (tool captures). Session 2's e2e records them as files.

---

## Session 1 — Findings for the founder

1. **The baseline lint is red.** `pnpm lint` at `9777818` reports 28 errors, all in files M10 committed: m10 seed/demo scripts, 5 calendar/transcript adapters, portal and surveys services, and the tests `tenant-isolation-m10.int.test.ts`, `brief-scheduler.test.ts`, `portal-pen-suite.int.test.ts` and `surveys.int.test.ts`. M10-LOG reports the gate green. The M11 close gate (typecheck + lint + test + build) cannot pass until these are fixed. Several are in pre-M11 test files, so per the standing rules I stopped there and did not fix them. **Decision needed before the Session 2 close.**
2. **The dev DB migration history has drifted** from the repo. `20261106120000_m8_campaigns` is applied but missing from the folder, and the M8 and M10 migrations were edited after being applied. `prisma migrate dev` (`pnpm db:migrate`) now demands a reset of `nexaworks_dev`. I did not reset; M11 migrations were applied with `prisma migrate deploy`. A diff against a scratch shadow DB also shows leftover M8 schema drift: two indexes, plus `updatedAt` defaults on Campaign, CampaignRecipient and VoiceSample.
3. **The seed has no historical renewals or health history**, so the ledger's demo sentence shows **0 recovered or renewed, worth $0**. The seed has no `RenewalOutcome` for its 12 historical renewals (M7 records one only for renewals it tracked) and no past health snapshots. Demo steps 7–8 ("47 recovered or renewed — worth $X", a save record ending "renewed") therefore cannot show a save from history.
   - Under D9 I did not hand-write outcome records.
   - Options for Session 2: (a) seed historical `Renewal` tracker rows so the real `syncRenewals` records outcomes, though that needs a forecast value at the time, which is a prediction number; (b) leave it honest and demo the save chain on Harborwood after `scripts/demo-renewal-outcome.ts` with a business clock 97 days on; (c) accept zero.
4. **The M10-LOG health table doesn't match the DB.** It lists Brightwell as WATCH with sentiment 40 (overall 52.50). The dev DB after a fresh seed shows Brightwell AT_RISK 52.52, sentiment null, and the portfolio is 5 At Risk / 0 Watch / 55 Healthy. M11 did not change this (proof above). Not investigated further.
5. **QBR and meeting-qbr snapshot reads** now exclude back-test rows but still don't filter by `healthModelId` (pre-existing).
6. **No code writes `PlayStep` action refs.** The ledger's per-play grouping matches plays through `PlayStepRun.approvalId/taskId/outboundMessageId` instead.
7. **Window mismatch between checkpoints:** the d90 checkpoint uses workspace business dates, while M7's revenue window is UTC days. They can disagree only at a time-zone edge; the demo workspace is UTC. The status rule itself is one shared function.

---

## Session 1 — Acceptance progress (M11.md §6; final status at Session 2 close)

| # | Check | Session 1 status |
|---|---|---|
| 3 | Ledger math correct, reconciles | `ledger.test.ts`, `ledger.int.test.ts` reconciliation; PASS so far |
| 4 | 90-day sentence; money only with canViewRevenue | tests + browser (Dana vs Leo); e2e screenshots in S13 |
| 5 | Save record links win → signal → action | page built; e2e assertion in S13 (see finding 3) |
| 6 | AI accuracy per agent/signal; Tune/Kill audited | `accuracy.test.ts`, `accuracy.int.test.ts` |
| 7 | Every report figure opens into records | built; e2e click-through in S13 |
| 13 | AgentRun for every digest | `digest.int.test.ts`; Ask AI part in Session 2 |
| 17 | Query budgets (reports + ledger) | 2-vs-5 tests in ledger, accuracy, reports |
| 18 | Tenant suite covers new models | `tenant-isolation-m11.int.test.ts` |
| 20 | D-67 resolved | D-158 + `live.test.ts` + back-test exclusion tests in checkpoints and reports |
| 1, 2, 8–12, 14–16, 19 | gate, e2e, Ask AI, files, voice, axe | Session 2 |

---

## State summary for Session 2

- **HEAD:** `d9931bc` on `main`, tree clean, 10 commits since `9777818`.
- **Schema:** done for both sessions (AskThread/AskMessage, ASK_ATTACHMENT exist). `files/service.ts` `authorize()` currently treats `ASK_ATTACHMENT` like a contract document (`revenue:view` + account). S11 must give it owner-only, thread-bound authorization. Its upload types are text only today (vtt/srt/txt/json); PDF comes with D-165 (`unpdf`, pinned).
- **Agents:** 14 registered; `ask-ai` makes 15 (`team.int.test.ts` 14→15 is pre-approved; Q-83 stays open). The registry is now lazy (`d9931bc`).
- **Approvals:** executors for CREATE_TASK / UPDATE_FIELD / ENROLL_PLAY / BULK_ACTION still do not exist (S9). D-160 condition: the Ask card is a view onto the Approval; Yes calls `approvals.approve()` with identical authority, and decide controls render only for users who could decide in `/approvals`.
- **Nav:** "Reports" and "Ask AI" are still `href: null`, `SHIPPED_MILESTONE = 10`. S12 adds the `11:` row in `features.test.ts`.
- **Commands added:** `pnpm outcomes:backfill --workspace <slug>`, `AI_PROVIDER=recorded pnpm reports:digest --workspace <slug>` (CLAUDE.md updated).
- **Economics used:** one mid-run done (batch 1 of 2 used). The close remains one full e2e, then one full gate.
- **Blockers to resolve before the close:** finding 1 (baseline lint) and finding 3 (demo history), both founder decisions.
