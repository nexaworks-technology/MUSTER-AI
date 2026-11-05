# M11 log — Ask AI, Reports & Outcome Ledger

> **M11 complete (2026-11-06).** Session 1 (S1–S7) and Session 2 (S8–S13 + close) below. The Session 1 sections are kept as written at the end of Session 1 (its "HEAD d9931bc" line predates the log's own commit `751c2f7`). Plan: `/Users/sahil/.claude/plans/distributed-weaving-glacier.md`. Founder decisions D1–D11 approved at the recommended defaults with conditions on D3, D5 and D6 (recorded as D-158..D-168, Q-16 answer, Q-83, Q-84).

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

---

## Session 2 — Founder additions handled first

1. **Lint housekeeping** (`1c276cc`, lint-only). 23 of the 28 errors in M10 files were fixed: unused imports and variables, one `prefer-const`, and two imports moved to the approvals module's public `service.ts`. Prettier also reformatted three neighbouring adapter files (freshdesk, microsoft-email, zendesk), with no logic change.

   | Pre-M11 test file | Change | Assertions |
   |---|---|---|
   | `src/lib/db/__tests__/tenant-isolation-m10.int.test.ts` | removed unused `rawDb` import | none changed |
   | `src/modules/meetings/__tests__/brief-scheduler.test.ts` | removed unused `mockJob` and the `Job` type import | none changed |
   | `src/modules/portal/__tests__/portal-pen-suite.int.test.ts` | dropped the unused `contactA` binding; the `create` call stays | none changed |
   | `src/modules/surveys/__tests__/surveys.int.test.ts` | removed unused imports; `bulkDecide` now comes from `approvals/service` (same function) | none changed |

   Re-run of the touched suites: 29 files, 176 tests, all green.

   The other 5 errors (portal and survey raw client and raw SQL) could not be fixed lint-only. I asked you and you chose the refactor (`aa5af73`):
   - the token lookups moved into `src/lib/db/token-access.ts`, with the same RLS settings and tagged SQL;
   - the portal `lastUsedAt` update now goes through `scopedDb`;
   - the survey-link secret now comes from env only. The known hard-coded fallback would have let anyone forge survey responses.

   Portal, survey and tenant-m10 suites: 4 files, 32 tests, green. `pnpm lint` is green for the whole repo.
2. **Ledger demo, option (b).**
   - `scripts/demo-m11-save-chain.ts` runs on Harborwood with explicit demo clocks: real rules (`renewal_window_30` on 2026-11-21) → a CSM check-in approved by Dana and sent through dispatch → the real renewal sync records RENEWED → the real checkpoint passes. Result: day 90 RENEWED + ACTED = saved, ARR at flag 570000 minor (USD 5,700). This agrees with M7's renewals-only `valueSavedMinor`.
   - Output is in `m11-evidence/harborwood-save-chain.txt`. Screenshots with `APP_FAKE_NOW=2027-02-25` are `m11-evidence/demo-clock-ledger-harborwood.jpg` (ledger: "Of 6 risks … acted on 1; 6 recovered or renewed — worth $5,700.00", attributed) and `demo-clock-save-record-harborwood.jpg`.
   - The seed gap is recorded as Q-85.
3. **Dev database.**
   - `nexaworks_dev` was reset and re-seeded with your consent.
   - On the clean seed Brightwell is WATCH, sentiment 40, overall **64.87**. That matches the committed M10 test (`seed-m9.int.test.ts:204`) but not the 52.5 in M10-LOG prose. I stopped and asked before the close; you decided 64.87 is right (Q-86).
   - The migration-history drift goes to M12 (below).
4. **Close ritual:** one full e2e, then the full `pnpm gate`. Both are below.

## Session 2 — What was built

| Slice | Model | Commit | What it is | Evidence |
|---|---|---|---|---|
| S8 Ask tools | **Opus** | `615eccc` | Read tools built on module services with the asker's Actor: workspace, role, book scope and money redaction behave as on each module's screen. Each tool returns citable records or an explicit `notFound`. There is no SQL, write or cross-workspace tool. The tools: searchAccounts, getAccount360Summary (+ contacts), listSignals, searchConversations (new book-scoped `conversations.searchExtractions`), listTickets, getContract, getHealthWithReasons, listPromises, listRenewals, readDocument, listPlays (S10), readUploadedFile (S11). | RED `s8-red.txt`; `tools-scope.int.test.ts`, enumerated over the registry (OWN-book CSM, workspace-B ids, no revenue figure without `revenue:view`) |
| S9 Approval executors | **Opus** | `1874708` | Change-list approvals (D-171): `CREATE_TASK`, `UPDATE_FIELD`, `ENROLL_PLAY`, and `BULK_ACTION` for more than one item. These run only inside `approve()`, item by item through each module's service as the decider. Refusals become plain skip reasons; one audit row per item. Added `plays.enrolAccountInPlay` and Ask AI `proposeChanges`. Approvals without a change list are unaffected. | RED `s9-red.txt`; `confirmed-actions.int.test.ts` 7 |
| S10 Ask agent | **Opus** | `3484a29` | `ask-ai-plan@1.0.0` plus a code loop (D-159; at most 6 steps and 24 calls, each tool run as the asker), then one `ask-ai@1.0.0` AgentRun (deep) whose bundle is rebuilt from the retrieval steps as the asker. The shared evaluator requires ≥ 1 citation to a retrieved record, every number (dates included, D-164) in a cited record, and figures that point at cited records. Otherwise the run is UNCITED and no AI text is stored. `act()` turns a proposal into an Approval (ids must be retrieved records) and outreach into a SEND_EMAIL approval through the dispatch guards. Threads are owner-only. | RED `s10-red.txt`; `ask-ai-validate.test.ts` 9; `ask-loop.int.test.ts` 7 |
| S11 /ask, files, card | Sonnet | `7fb5350` | `unpdf@1.9.1` (exact pin, published 2026-10-19; D-165). ASK_ATTACHMENT files are owner-only and read only when `scanStatus = CLEAN`; passages carry offsets. /ask renders only SUCCEEDED answers with citation links. The confirmation card is a view onto the Approval, loaded as the viewer: decide controls appear only when `canDecideApproval` passes (the same check /approvals now uses, rule unchanged), and Yes/No call `approve()`/`reject()`. | `files.int`, `confirmation-card.int`, `thread-view.int` (2 vs 5 messages, equal queries) |
| S12 Voice + nav | Sonnet | `bae5599` | `ask.voiceDictation` (default off, Admin-only, audited, disclosure text per Q-11). Browser dictation fills the text box only. Nav gains Reports and Ask AI; `SHIPPED_MILESTONE = 11`. | `voice.test`, `voice-dictation.int`, `features.test` (`11:` row only) |
| S13 Seed + e2e | Sonnet + Opus | `0e0ad22`, `f910185`, `018ca27`, `28acf79`, `0cf13ea` | `scripts/recorded-ask.ts` composes the planner and answers from tool records (recorded transport), with `--publish-play` and `--thread/--file`. Seed M11 returns renewal-risk to DRAFT. Demo PDF `e2e/fixtures/northgate-contract-terms.pdf`. `e2e/m11-ask-ledger.spec.ts`, `e2e/a11y-m11.spec.ts`, `e2e/support/m11.ts`. | close e2e below |

Pre-approved registry edit: `team.int.test.ts` agent keys 14 → 15 (`+ "ask-ai"`). Over both sessions that is 13 → 15, as you pre-approved. No other pre-M11 test changed apart from the founder-approved lint housekeeping above, and none of those changes touched an assertion.

## Session 2 — Incidents, read and fixed

1. **Load-order cycles** (S10): `ask-ai/service` → agents → `ask-ai` definition → `ask-ai/service`. Fixed by loading the agents module inside `askQuestion` and making the change-item schemas `z.lazy`. Behaviour-neutral.
2. **The demo script froze checkpoints workspace-wide** (my bug, found in the demo screenshot). The first save-chain run passed the moved clock to the workspace-wide evaluators, which froze day 7/30/90 early for 60 seeded flags in `nexaworks_dev` and 61 in `nexaworks_test`. The freeze trigger rightly refused any repair.
   - Fix `28acf79`: the evaluators take an optional account scope (the job still runs workspace-wide), the demo passes one account, and a new test shows a scoped run touches only the named accounts.
   - With your consent both local databases were reset and re-seeded. On the clean dev run, the only early-dated day-90 results are the demo account's own six flags.
3. **The S13 spec work took 7 targeted runs** of the two new spec files, beyond the two fix batches. Every failure was in the new specs or their setup; no product code changed.

## Session 2 — Close: one full e2e, then the full gate

| Run | Result |
|---|---|
| Full `pnpm test:e2e` | **95 passed, 2 failed**, 80 skipped (mobile project skips desktop-only flows), 9 did not run (serial suites after a failure), 4.3 min |
| Batch 1 (failures read together) | (1) `m7 Dana's radar`: the M11 spec's save chain recorded Harborwood's renewal (append-only) before M7 ran, because `m11-…` sorts before `m7-…`. (2) `m11 weekly digest`: the manual dev trigger reused the weekly dedupe job id, and Redis still held the completed job from before the DB reset. Fix `0cf13ea`: the e2e chain moved to Northbrook Fabrication (renewal 2027-03-21, outside the radar, referenced nowhere else), and the manual trigger now uses `manualRunId` (D-81 uniqueness-intended). `nexaworks_test` was reset with your consent. |
| Batch 2 (failed specs + shared-setup a11y): `m7-renewals-revenue`, `m11-ask-ledger`, `a11y-m11` | **21 passed, 0 failed**, 19 skipped (mobile flows) |
| Full `pnpm gate` (typecheck → lint + secrets → test → build) | **green**: secret-check 1,449 files, no secrets; **284 test files / 2,651 tests passed**; build compiled, 54 static pages |

Baseline M10: 256 / 2,386. Session 1 mid-run: 275 / 2,531.

AgentRun evidence (acceptance #13, dev DB, `m11-evidence/agentrun-query.txt`):
- 4 of 4 ASSISTANT messages have an `ask-ai@1.0.0` AgentRun with model and input refs.
- The leader digest run is SUCCEEDED, `leader-reporter@1.0.0`, model `recorded`, 41 input refs, and 4 snapshots carry its `digestAgentRunId`.

---

## Acceptance checklist (M11.md §6)

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | 284 files / 2,651 tests; typecheck, lint + secrets, build green |
| 2 | `pnpm test:e2e` incl. `m11-ask-ledger` green | **PASS (after batch 2)** | full run 95/97 → batch 2 on the failed specs 21/21 (causes fixed in M11 test code) |
| 3 | Ledger math correct, reconciles | **PASS** | `ledger.test.ts`; `ledger.int.test.ts` reconciliation + M7 agreement |
| 4 | 90-day sentence; money only with canViewRevenue | **PASS** | `ledger.test.ts` redaction; e2e Dana vs Leo (`ledger-dana.png`, `ledger-leo.png`); demo-clock ledger with $5,700.00 (`demo-clock-ledger-harborwood.jpg`). On the e2e clock the ledger cohort has no saves (Q-85), so the e2e asserts money on the save record |
| 5 | Save record links win → signal → action | **PASS** | e2e "Save record" test (signal → approval → sent email → RENEWED day 90 → saved) |
| 6 | AI accuracy; Tune/Kill audited | **PASS** | `accuracy.test.ts`, `accuracy.int.test.ts` (audit rows, CSM refused); e2e drill-down |
| 7 | Every report figure opens into records | **PASS** | report figures carry source ids + hrefs (`reports` tests); e2e click-through |
| 8 | No citation → not rendered | **PASS** | `ask-ai-validate.test.ts`; `ask-loop.int.test.ts` |
| 9 | Number not in tool output rejected | **PASS** | `ask-ai-validate.test.ts` (incl. dates, D-164); `ask-loop.int.test.ts` UNCITED |
| 10 | "I cannot see a contract" | **PASS** | `ask-loop.int.test.ts`; e2e Fairhaven thread |
| 11 | Bulk action without confirmation does nothing | **PASS** | `confirmed-actions.int.test.ts`; e2e (zero play runs before Yes) |
| 12 | Ask AI cannot read another workspace or outside the book | **PASS** | `tools-scope.int.test.ts` (enumerated); owner-only threads (`ask-loop`, e2e) |
| 13 | AgentRun for every answer and digest | **PASS** | DB query above |
| 14 | Uploaded files used only after scan CLEAN | **PASS** | `files.int.test.ts` (PENDING, REJECTED never read) |
| 15 | Voice off by default; Admin-only | **PASS** | `voice-dictation.int.test.ts`, `voice.test.ts`; `voice-setting-off.png` |
| 16 | Live Ask AI eval on a fixed question set | **DEFERRED → M12** | no `ANTHROPIC_API_KEY`; recorded transport only |
| 17 | Query budgets (reports, ledger, Ask) | **PASS** | 2-vs-5 tests in ledger, accuracy, reports, thread view |
| 18 | Tenant suite covers new models | **PASS** | `tenant-isolation-m11.int.test.ts` |
| 19 | axe on /ask, /reports, outcomes, ai-accuracy (desktop + 375 px) | **PASS** | `a11y-m11.spec.ts` (9 screens, both projects) |
| 20 | D-67 resolved | **PASS** | D-158; `live.test.ts`; back-test exclusion tests (checkpoints, reports) |

## Decisions and questions added in M11

- **Decisions:** D-158…D-171.
- **Questions:**
  - Q-16 answered: outcome-based alarms, founder-decided.
  - Q-83: agent roster is 15 vs §6.2's 14; open.
  - Q-84: d7 due date uses raw ms; open.
  - Q-85: seed gap; recorded.
  - Q-86: Brightwell figures; founder-decided.
- **Status of the questions M11.md names:** Q-11 implemented as decided; Q-15 implemented (attributed labels on every money figure); Q-18 enforced for ASK_ATTACHMENT.

## Known risks

- **Ask AI latency and cost:** up to 6 planner calls plus one deep answer per question. Planner token use is recorded on the AskMessage, not summed into the AgentRun.
- **Prompts are unproven against a live model.** Recorded answers are composed by rules.
- **`readUploadedFile` is enforced as owner + CLEAN, not per thread.** The planner is only shown the current thread's files.
- **Nav TypeScript crash.** The Link route union reached a TypeScript internal-assertion size; the nav Link uses `{ pathname }`. More routes could hit it elsewhere.

## M12 hand-off

1. **Live checks:**
   - live Ask AI eval (#16) and the Leader Reporter prompt on a real model;
   - M10 sandbox calendar/transcript sync;
   - the PDF extraction on real contracts.
2. **Docker #16** stays PARTIAL; services ran via `pnpm services:native`.
3. **Q-81** carried as open.
4. **Git history scrub:** the removed hard-coded survey secret fallback (`$REMOVED_SURVEY_FALLBACK`) remains in history. Rotate anything that ever relied on it and scrub per the security pass.
5. **Migration-history reconciliation** (not done in M11):
   - `20261106120000_m8_campaigns` was applied on dev but is missing from the repo;
   - the M8 (`20261106121000_m8_campaigns`) and M10 migrations were edited after being applied;
   - `migrate diff` shows leftover M8 schema drift (`Campaign_approvalId_key`, `OutboundMessage_workspaceId_campaignId_idx`, `updatedAt` defaults on Campaign, CampaignRecipient, VoiceSample).

   A `migrate reset` drops the runtime role's schema grants; re-apply them (`docker/postgres/grants.sql` statements plus `GRANT … ON ALL TABLES/SEQUENCES/FUNCTIONS … TO app_user`).
6. **IP rate limit and body-size hardening** for the public or upload endpoints:
   - `POST /api/ask/files` (25 MB, authenticated);
   - portal `/portal/[token]` and survey submit (token-only, unauthenticated);
   - the webhook routes;
   - `askAction`, since each question can make up to 7 model calls.
7. **e2e isolation:** the test DB is shared and not reset between runs, and recorded renewal outcomes and frozen checkpoints are append-only. Specs must use accounts outside other specs' assertions, as M7 and M11 now do. Consider a per-run DB reset in global setup.
8. **Server Actions and Ask tools** for the enumeration tests:
   - **Server Actions:** `askAction`, `decideCardAction` (ask-ai), `generateReportAction`, `tuneRuleAction`, `killRuleAction`, `saveVoiceDictationAction`, plus the existing `saveWorkspaceProfileAction`.
   - **Route:** `POST /api/ask/files`.
   - **Ask tools:** the 12 above.
9. **Heaviest queries** for the performance pass:
   - `reports` adoption (31 queries per generation, constant);
   - `loadLedger` (period + 92-day load window);
   - `evaluateLongCheckpoints` (workspace-wide fact loads);
   - Ask AI retrieval (tool reruns in `buildContext`).
10. **Jobs for the 2,000-account nightly run:**
    - `outcomes.checkpoint` (now d7, revenue and d30/d90);
    - `reports.weeklyDigest` (per-workspace Monday cron);
    - snapshot generation for the four digest reports.
11. **§11 pilot instrumentation hooks:** Ask AI questions and answers (status, citations, proposals → approvals decided); ledger saves per period; cries-wolf rule changes (`signal_rule.updated`); digest delivered/failed.

## Erratum (added in M12)

The M12 hand-off item 4 mentioned the removed survey fallback string. That literal was replaced by `$REMOVED_SURVEY_FALLBACK` in the M12 A2 history rewrite (D-172), and the scrub that item asked for is done (M12 A2).
