# M4 log: Agent Framework, Today & Approvals

**Date:** 2026-11-03 · **Result:** **NOT COMPLETE.** All slices are built, and 14 of 16 acceptance checks PASS. **#1 (gate) and #2 (e2e) are FAIL on the last runs** and await one more gate + e2e run after a founder decision (see "Final gate and e2e"). Two of the three failure causes were M4 defects and are fixed (`827213f`). The third is test-environment state left by M3's nightly scheduler running on the real clock during an e2e setup.
**Carried from M1, unchanged:** M1 acceptance **#16 is PARTIAL** (Docker not installed; founder-approved). No docker command was run in M4.
**AI and email transports in this milestone:** `ANTHROPIC_API_KEY` is unset. No live model was called anywhere in M4. Tests use fake providers; the e2e and the demo use the **recorded** transport, with fixture answers composed from the records by `scripts/recorded-agents.ts` and run through the real executor. Every customer email went through `dispatch` to the **log** transport; nothing left this machine. `pnpm eval` (live) is **DEFERRED** (no key). Live Resend verification is deferred to M12, or earlier if a key is provided.

## Baseline

At `b01fa5b` (fix session on top of review `a13f47b`): `pnpm gate` green, **79 files / 821 tests**. E2e was not re-run at baseline: the review ran it at 31 passed / 21 skipped on this code, and no e2e file had changed since.

## What was built

One Conventional Commit per slice.

| # | Slice | Commit |
|---|---|---|
| 1 | Models: AgentDefinition, AgentRun, Approval, **DraftRevision** (founder point 3), OutboundMessage, EmailSuppression, TodayItem, Extraction. RLS ENABLE + FORCE, composite FKs, registry; FKs on every existing `agentRunId`. DB CHECKs: SUCCEEDED ⇒ audit fields; agent proposal ⇒ proof; sensitive ⇒ ≤ DRAFT_FOR_APPROVAL and never decided from Slack; decisions name who, when and where; drafts immutable. | `79d520a` |
| 2 | `defineAgent`, registry plus startup prompt check, executor (idempotency key, statuses, one repair call, citation / quote / number validators, forbidden-numeric overwrite, sourceKey side effects, 4 transient retries with backoff and jitter, D-74 refusal policy, token budget, AuditLog per run), D-75, strengthened no-AI guard. | `877b883` |
| 3 | Guards and sending (rule 1): level resolver, `detectSensitive`, the 8 pure guards, `dispatch` pre-checks on every send, customer transport (log in dev, Resend in prod), import-graph test. | `2a34383` |
| 4 | Approvals: request / approve / edit-then-approve / reject / bulk, assignee and book rules, the Slack data rule, `/approvals` and `/approvals/[id]` (D-76). | `6e84cea` |
| 5 | Health Analyst plus `<AiText>` on the Health tab; 10 golden fixtures. | `147d565` |
| 6 | Watcher-basic, extraction validators, Sentiment pillar from verified labels (D-77); 15 golden fixtures; `pnpm agents:extract`, `pnpm eval`. | `7eb94be` |
| 7 | Draft check-in from a signal or a ticket; basic Outreach Agent (D-30); 6 golden fixtures. | `d8f0596` |
| 8 | Today ranking, service, page and hourly rebuild; Today and Approvals in the nav (D-78). | `63bcadd` |
| 8a | Today is the post-sign-in landing page (founder-approved e2e edits, Q-46). | `2f9fcbe` |
| 9 | Overdue escalation to CS Leaders. The seeded overdue tasks cover the demo, so **seed v3 was not needed and the seed is unchanged**. | `efdbae4` |
| 10 | OutcomeRecord ACTED / IGNORED plus the 7-day checkpoint (D-79). | `972a43d` |
| 11 | Audit viewer and audited export; AI team pages; agent switch; run detail; log-content test. | `e224a9e` |
| 12 | e2e `m4-today-approvals.spec.ts` plus `a11y-m4.spec.ts`; `scripts/recorded-agents.ts`; `AI_RECORDINGS_DIR`. | `fbe312f` |
| 13 | Fresh-database demo, this log, plan, changelog, decisions, questions. | this commit |

## Kickoff rules: how each was met

| Rule | Result | Evidence |
|---|---|---|
| 1 First customer email = the guards milestone | Met | All guards, the sensitive check and the pre-checks shipped in the same slice as `dispatch` (`2a34383`). `guards.test.ts`: every guard passes and fails alone, including the 2d23h / 3d1h and 47h / 49h boundaries, unknown time zone → hold, LOST, and sensitive blocked even with the switch on. `dispatch.int.test.ts`: wrong approval level, sensitive auto attempt (held, flagged), opted-out / bounced / departed contact, missing sources, AI draft from a non-SUCCEEDED run, edited-after-approval text, kill switch: **an approved send succeeds with the switch off; an automatic send with the switch off is blocked by guard 8** (point A). |
| 2 The precise AI claim | Met | D-75 and CLAUDE.md. `health-no-ai.test.ts` now also catches side-effect, dynamic `import()`, `require` and re-export forms. Extraction labels are kept only with a verified quote (`extraction-validate.test.ts`). Narrative numbers (counts, money, dates, percentages) must appear in a cited record (`citations.test.ts`). |
| 3 Everything an agent does is an AgentRun | Met | `executor.int.test.ts`: all audit fields; INVALID_OUTPUT after exactly one repair call; UNCITED; refusal = FAILED / MODEL_DECLINED with one call and nothing written; 4 retries then FAILED with the code; permanent error fails at once; budget → SKIPPED. Effects are recorded on `AgentRun.effects`; citations must resolve to input records. DB CHECK `agentrun_succeeded_complete`. |
| 4 Approvals are the only door out | Met | Every send passes `dispatch` pre-checks. Approve / edit / reject / bulk are audited. An edit writes DraftRevision v(n+1), immutable by trigger. The Q-31 Slack rule is in the service and the DB. `approvals.int.test.ts`. |
| 5 New tenant models use the fixed pattern | Met | `tenant-isolation-m4.int.test.ts`: 8 models × {read, real-field update with own-row control via `update-attack.ts`, delete, raw SQL}, composite-FK cases, cross-tenant approve / reject → 404, context builder cannot load B's records, audit export only A's rows. |
| 6 Tests never call the live API | Met | Fake providers in integration tests; golden replay in CI (health-analyst 10, outreach 6, extraction 15, adversarial cases included); e2e on the recorded transport. `pnpm eval` prints DEFERRED without a key. |
| 7 Nav via features.ts; M4 row only | Met | `SHIPPED_MILESTONE = 4`; `features.test.ts` gains the M4 row only. Today is the landing page (M4.md says so; Q-46). |
| 8 Lean execution | Met, with one gate failure reported | Gate #1 after the core **failed at the build step**: typecheck, lint and all 91 files / 967 tests had passed, but `next build` type-checked a half-written slice-5 file I had created while the gate ran (my sequencing error, not committed code). Fixed, and the one allowed re-run passed on a clean tree: **93 files / 986 tests**. Final gate: **FAIL**: 105 files / 1,056 tests, 6 failed in 2 pre-M4 files (causes below). |

## Acceptance checklist (docs/milestones/M4.md §6)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **FAIL** (fix committed, re-run pending) | Final run: typecheck and lint OK (598 files secret-scanned, no secrets); **Test Files 2 failed / 103 passed (105), Tests 6 failed / 1,050 passed (1,056)**; build not reached. Causes and fixes are under "Final gate and e2e". |
| 2 | `pnpm test:e2e` green for `e2e/m4-today-approvals.spec.ts` | **FAIL** on the full run (M4 spec alone: PASS) | M4 specs alone (`m4-today-approvals` + `a11y-m4`): **9 passed, 7 skipped, 0 failed**. Full suite after the gate: **32 passed, 3 failed, 28 skipped**. The failures are M1 invitation (EISDIR, fixed), M3 "Leo opens Brightwell's health" (test-state pollution) and M4 "Brightwell's Health tab…" (stale-snapshot narrative, fixed). |
| 3 | Tenant suite and registry cover new models; cross-tenant approve and export blocked | **PASS** | `tenant-isolation-m4.int.test.ts` › "<Model>: A cannot read, update or delete B's row" × 8, "raw SQL without the workspace setting sees nothing" × 8, the composite-FK cases, "approving or rejecting B's approval from A is not found (404)…", "A's agent context builder cannot load B's records", "the audit export contains only A's rows"; `model-registry.int.test.ts` (unchanged) classifies all 8 new models and checks their RLS. |
| 4 | Every SUCCEEDED AgentRun has prompt version, model, inputRefs, output, reasoning, confidence; DB CHECK enforces | **PASS** | `executor.int.test.ts` › "a SUCCEEDED run carries every audit field…"; `m4-constraints.int.test.ts` › "refuses a SUCCEEDED run without its audit fields"; CHECK `agentrun_succeeded_complete` in `20261103051529_m4_agents_approvals`. |
| 5 | UNCITED / INVALID runs render nothing; every AI block shows sources | **PASS** | `citations.test.ts` (ids, quotes, numbers, dates, percentages); `executor.int` › "INVALID_OUTPUT after exactly one repair call; nothing is rendered" and the UNCITED case; `health-analyst.int` › "an uncited answer is stored as UNCITED and the Health tab shows nothing from it"; e2e › "Brightwell's Health tab…" asserts every `ai-sources` list has links. |
| 6 | Retried jobs never duplicate approvals, tasks or drafts | **PASS** | `executor.int` › "a crash after persist, then a retry, never duplicates the approval (sourceKey)"; "the same trigger twice gives one AgentRun and one model call"; `approvals.int` › "is idempotent by sourceKey". |
| 7 | Only `dispatch` can send; sending without an approved Approval throws | **PASS** | `import-graph.test.ts` (all import forms); ESLint restricted import (pre-existing); `dispatch.int` › "sending without an approved approval throws", "a REJECTED approval cannot send". |
| 8 | All 8 guards + sensitive detector, tested; auto-send disabled until M8 | **PASS** | `guards.test.ts`, `sensitive.test.ts`, `level-resolver.test.ts`, `dispatch.int.test.ts`. The switch is `z.literal(false).catch(false)` in settings with no UI. e2e › "AI team: … no auto-send switch"; screenshot `12-ai-team.jpg`. |
| 9 | Today ranking deterministic, own book, reasons shown | **PASS** | `ranking.test.ts`; `today.int.test.ts` (own work only, 25 per page, no ARR without access, same order); e2e › "Leo lands on Today…"; `01-today-leo.jpg`. |
| 10 | Overdue tasks escalate to the CS Leader | **PASS** | `overdue-escalation.int.test.ts`; e2e › "Dana's Today shows Aisha's escalated overdue task"; `11-dana-today-escalated.jpg`. |
| 11 | Audit viewer and export work and are audited | **PASS** | `audit.int.test.ts`; e2e › "Audit: filter…; export CSV; the export is itself listed" (real download); `15-audit-filtered.jpg`, `16-audit-export-listed.jpg`. |
| 12 | Agent pages show what each agent read, decided and did | **PASS** | `team.int.test.ts`; e2e › "AI team: what the Health Analyst read, decided and did; a failed run is shown as failed…"; `14-…read-decided-did.jpg`, `13-failed-run-shown-as-failed.jpg`. |
| 13 | OutcomeRecord ACTED after approve → send | **PASS** | e2e › "Draft check-in on the usage drop → … flag ACTED" (DB assertion); `actioned.int.test.ts`. |
| 14 | No AI content in logs; model names only from env | **PASS** | `ai-logging.int.test.ts` (no prompt, record or model text in any log call); `git grep -n "claude-" -- src` returns nothing; models come from `AI_MODEL_*` per tier. |
| 15 | Golden extraction replay green; live eval run or DEFERRED | **PASS** (live eval **DEFERRED**, stated) | `extraction-replay.test.ts` (15 fixtures), `golden-replay.test.ts` (health-analyst 10, outreach 6). `pnpm eval`: "DEFERRED — ANTHROPIC_API_KEY is not set …; no live model was called." |
| 16 | axe clean on /today, /approvals, /settings/audit, /settings/ai-team | **PASS** | `e2e/a11y-m4.spec.ts` › "axe: today, approvals, check-in, audit, AI team, agent run, home" on desktop (1280 px) and mobile (375 px), every `<details>` opened. M4.md names `e2e/a11y.spec.ts`; pre-M4 a11y files are not edited, so this is a new file, as in M3. |

## Where each guard lives (as approved)

- **Guards 1–8:** the pure `evaluateGuards` in `src/modules/outbound/guards.ts`. The sensitive words list is in `src/modules/outbound/sensitive.ts`.
- **Pre-checks:** in `src/modules/outbound/dispatch.ts`, run on **every** send:
  - the approval is APPROVED or EDITED_APPROVED;
  - the approver has `approvals:decide` on the account;
  - the level is DRAFT_FOR_APPROVAL;
  - it was decided in the app;
  - the sent text is the approved version;
  - at least one source;
  - an AI draft comes from a SUCCEEDED run;
  - guard 7 (suppression, or a bounced or departed contact).
- **Q-31 Slack rule:** a data rule in the approvals service, plus DB CHECK `approval_sensitive_not_slack`.

## Regression statement

| | Baseline (`b01fa5b`) | Final |
|---|---|---|
| `pnpm gate` | green · 79 files · 821 tests | **FAIL** · 105 files · 1,056 tests (6 failed) · re-run pending |
| `pnpm test:e2e` | 31 passed · 21 skipped (review run) | **FAIL** · 32 passed · 3 failed · 28 skipped · re-run pending |

**Every pre-M4 test still exists.** Pre-M4 test files changed (`git diff b01fa5b` over the 174 test and test-infrastructure paths that existed there): exactly five, all founder-approved.

1. `src/config/__tests__/features.test.ts`: the M4 row only; existing rows untouched.
2. `src/modules/health/__tests__/health-no-ai.test.ts`: the regex now also catches side-effect, dynamic and `require` imports, with self-checks for each (M4 rule 2).
3. `src/lib/db/__tests__/update-attack.ts`: entries for the 8 new models; DraftRevision is "frozen", like snapshots.
4. `e2e/support/app.ts`: `signIn` expects `/today` (Q-46).
5. `e2e/m1-foundation.spec.ts`: the two Home checks after sign-in open `/` first (Q-46).

No assertion was loosened. `a11y.spec.ts` is unchanged; since sign-in lands on Today, its first scanned page is now Today, and Home is scanned in `a11y-m4.spec.ts`.

## Final gate and e2e: what failed and why

**Final gate:** 6 failures in two pre-M4 test files.
- `settings.int.test.ts` ×5: **EISDIR**.
- `seed-health.int.test.ts` ×1: a current snapshot dated 2026-11-03 instead of SEED_TODAY.

**Full e2e:** 3 failures.
- M1 invitation: EISDIR.
- M3 "Leo opens Brightwell's health": the reason text belonged to a different snapshot.
- M4 "Brightwell's Health tab": the narrative cited a reason that was not on the page.

The three causes:
1. **M4 defect, fixed in `827213f`:** the customer log transport wrote into `.dev-mail/customer/`, a subdirectory of the folder the pre-M4 invitation test and the e2e `inviteLinkFor` helper read file by file. Customer dev mail now goes to the sibling `.dev-mail-customer/`. The pre-M4 settings tests pass again (targeted run: 7 files / 67 tests).
2. **M4 defect, fixed in `827213f`:** the Health Analyst wrote about `account.currentHealthSnapshotId`, while the Health tab shows the latest live snapshot under the **active model**. After a model change, or a later nightly run, the narrative cited reasons that were not on the page. The trigger, sweep, narrative reader and fixture script now all use `displayedSnapshot()`, and a narrative about any other snapshot is not shown. Regression test: `health-analyst.int` › "shows a narrative only about the snapshot the Health tab shows, never an older one". Targeted run: 27 files / 215 tests.
3. **Not M4 code; test-environment state:**
   - The e2e worker (`playwright.config.ts` starts `src/worker/index.ts`) registers M3's nightly scheduler for every workspace in `_test` under the `nexaworks-e2e` queue prefix in Redis.
   - The next 02:00 run in America/New_York fell due at 07:00 UTC on Nov 3.
   - The first e2e started after that (slice 12, 09:02 UTC) ran it at once, **on the real clock**. That wrote 63 snapshots dated 2026-11-03 into `_test`'s `larkspur-demo`, which is meant to stay "as of SEED_TODAY".
   - Evidence: the snapshots were created 0.3 s after the e2e re-seed's `seed.applied` audit row, and Redis holds `nexaworks-e2e:signals:repeat:nightly-*` jobs.
   - The baseline gate and the review's e2e both ran before 07:00 UTC, which is why it never showed before.

   Re-running the gate needs this state cleaned. Stopping it from recurring needs the e2e worker not to register real-clock nightly schedules, which means a founder-approved change to `playwright.config.ts` (Q-49).

## Clock seam (Q-49 round 3, D-81): audit of real-time reads

The audit covers every `new Date()`, `Date.now()` and former `systemClock` under `src/modules`, `src/lib/jobs` and the worker entry.

**(a) Business "today", now routed through `businessClock`:**
- the injected default clock of every service that took `systemClock`:
  - `worker/processors.ts` pipeline (nightly kickoff, chunk evaluate and score, and the run a model activation or "Recompute now" queues);
  - `signals/pipeline.ts` (`enqueueAccountEvaluation`, `enqueueWorkspaceRun`, `enqueueBacktest`);
  - `signals/service.ts` (`createOutsideSignal`);
  - `health/service.ts` (Health tab and overview reads, Pulse, `recomputeAccounts`);
  - `health/actions/model.ts` (`saveModelEdit`);
  - `agents/executor.ts` (daily token budget);
  - `approvals/lifecycle.ts` (decision time);
  - `outbound/dispatch.ts` (send guards, `sentAt`);
  - `outcomes/service.ts` (acted / checkpoint);
  - `tasks/escalation.ts`;
  - `today/service.ts`;
- `lib/dates` `todayIn` default;
- `imports/writers.ts` role `validFrom` and outside-signal `now` (the import job runs on the worker);
- `billing/service.ts` `recomputeCommercials` `asOf` (ARR and renewal "as of today"; also run by the import job).

**(b) Real time, unchanged, with the reason:**
- *Token expiry and acceptance:* `settings/service.ts` invitation `expiresAt` / `revokedAt` / `acceptedAt`.
- *Record timestamps of a user's action:*
  - `tasks/service.ts` `completedAt`;
  - `signals/service.ts` `acknowledgedAt` / `markedFalseAt`;
  - `notifications/service.ts` `readAt`;
  - `accounts/data-quality-service.ts` `fixedAt` / `validTo`;
  - `accounts/service.ts` `stageChangedAt`.
- *Model lifecycle audit stamps:* `health/backtest-service.ts` and `health/service.ts` `activatedAt` / `retiredAt`.
- *Run bookkeeping and durations:* `agents/executor.ts` `startedAt` / `finishedAt` / `latencyMs`.
- *Import job bookkeeping:* `imports/service.ts` `confirmedAt` / `startedAt` / `finishedAt`.
- *Infrastructure:* `lib/jobs/outbox.ts` `availableAt` / `processedAt`.
- *Export file name:* `audit/service.ts` export date stamp.
- *Liveness log:* `worker/processors.ts` heartbeat.
- *Request-path reads outside the job and worker scope of this fix, unchanged:*
  - `contacts/service.ts` champion change time;
  - `usage`, `support`, `billing` (page reads), `timeline`, `segments` "now";
  - `accounts/service.ts` missing-data `now`;
  - `accounts/data-quality-service.ts` scan default;
  - `approvals/schemas.ts` `waitingFor`.

**Tests:**
- `src/lib/dates/__tests__/business-clock.test.ts` proves the fake value is ignored without the flag, with any other flag value, and in production; refuses a malformed value; and shows `realClock` is never faked.
- `src/worker/__tests__/business-clock.int.test.ts` shows that under the fake clock the nightly kickoff and a re-score date 2026-11-02, audit rows keep real time, and both e2e servers carry the pin.

## Decisions and questions

- **New decisions:**
  - D-74: model-declines and retry policy.
  - D-75: the precise AI claim.
  - D-76: approvals (assignee, bulk, Slack).
  - D-77: Watcher-basic and the Sentiment pillar.
  - D-78: Today.
  - D-79: outcome ledger, ACTED / IGNORED and the 7-day checkpoint.
  - M4.md's and the plan's "structured output via a tool" wording is marked superseded by D-35 (founder point 1).
- **Questions:**
  - Q-46 (landing page, answered).
  - Q-47 (e2e web server has no recorded provider; open, test infra only).
  - Q-48 (tasks carry no flag link → M8).
  - Q-49 (the e2e worker runs real-clock nightly jobs against the seeded `_test` workspace; open, blocks the final gate).
- **Sensitive keyword list location:** `src/modules/outbound/sensitive.ts` (versioned in code, reviewed like any rule).
- **Token budget default:** 2,000,000 tokens per workspace per day (`WorkspaceSettings.data.ai.dailyTokenBudget`).

## Problems found while building, and their fixes

1. **Gate #1 failed on a file I was writing during the run.** Reported under rule 8. From then on, no file was edited while a gate ran.
2. **An invalid time zone fell back to the next zone.** If the contact's zone was set but not a real zone, the quiet-hours guard used the account's zone instead. A zone that is set but invalid now counts as unknown and holds; falling through would guess. The test (written first) caught it.
3. **The usage-drop signal's title.** On screen it is "Usage fell to 58% of normal", not the rule name. The e2e first assumed the rule name.
4. **Approve and reject confirmations vanish.** The decision controls unmount once an approval is decided, so the page now relies on the lasting outcome ("Email status: sent … (log transport)", the send checks, "Rejected by …"). The e2e asserts that, as in M3.
5. **e2e URL match.** The regex `/approvals/[^/]+$` also matched `/approvals/new?…`, so the e2e read the id too early; it now excludes `new`.
6. **Pipeline query budget.** The pre-M4 per-chunk budget (≤ 67 statements) would have broken with a new loader query. Sentiment reads the label from the message query the loader already runs (D-77).

## Test and fixture corrections (expected values changed before or while the code was written)

| Test | Was | Now | Why |
|---|---|---|---|
| `ranking.test.ts` moneyWeight | `$99,900 → 3 (±0.0005)` | `$99,000 → 3 exactly` | My arithmetic: 1 + log10(100.9) ≈ 3.0039. |
| e2e status line after approve | transient "The email was sent" | lasting message status + "edited approved" | The control unmounts when decided (see 4 above). |
| e2e signal locator | "Usage drop vs normal" | "Usage fell to 58% of normal" | The signal's real title (see 3 above). |

## Demo run (fresh database)

`nexaworks_m4demo` was created and granted (`docker/postgres/grants.sql`), then `prisma migrate deploy` from empty applied **17 migrations**. The seed with the test tenant took **9 s** and includes the nightly pipeline.
- **Agents:** `scripts/recorded-agents.ts` on the **recorded** transport. It printed "AI transport: RECORDED. Fixture answers composed from the records…; no live model is called". Health Analyst Brightwell SUCCEEDED; Halden a **recorded refusal → FAILED**; 36 Watcher runs SUCCEEDED; Outreach Brightwell SUCCEEDED.
- **Escalation:** `scripts/tasks-escalate.ts` escalated **2** overdue tasks.
- **Data setup for the guard demo:** one Northgate contact (Dora Lindqvist) was put on the suppression list as "unsubscribed".
- **App:** `next dev` on port 3200 against that database, with its own queue prefix. Screenshots are in `docs/milestones/m4-evidence/`.

1. **Leo lands on Today** (`/today`): "Follow up with Halden on the CSV export fix · Halden Retail — Account value × overdue 10 days" first, then Brightwell's critical signals. Leo has no revenue access, so "Account value" is shown and no ARR. `01-today-leo.jpg`.
2. **Brightwell › Health** (Watch 68, model v1).
   - "What the Health Analyst sees" shows two items: "Champion Maya Ortiz: email bounced (Oct 27, 2026)." and "Typical weekday active users fell from 40 to 20.4 (−49%) …".
   - Each item has its reason link, the model confidence of 70% (labelled as the model's own estimate) and "What it read".
   - **Every citation was clicked through:** both landed on the Health tab with the pillar open and that exact reason highlighted (`aria-current`).
   - "What it read" opened the run: **33 input links, all HTTP 200**.
   - Screenshots: `02-brightwell-narrative.jpg`, `03-citation-1/2-lands-on-reason.jpg`, `04-run-what-it-read.jpg`.
3. **The AI draft, edited then approved.**
   - In Approvals: "Check-in about: Usage fell to 58% of normal", with proof "Signal: Usage fell to 58% of normal" and "Contact: Ben Okafor", "Drafted by the outreach agent (what it read)".
   - Leo edited one sentence ("…for your team this month?") and approved.
   - Result: "edited approved", "Email status: sent … (log transport)", all 14 send checks listed.
   - The dev email log `.dev-mail/customer/2026-11-03T09-07-06.818Z-log-….json` has transport "log", to ben.okafor@brightwell-logistics.test, and contains the edited sentence. (The demo ran before `827213f`; that file has since moved to `.dev-mail-customer/`, where customer dev mail is now written.)
   - Screenshots: `05-approvals-leo.jpg`, `06-edited-approved-sent.jpg`.
4. **A send blocked by a guard, shown.**
   - Leo wrote a check-in on Northgate's "API rate limit errors on nightly sync" ticket to Dora and approved it.
   - The page shows "Email status: held. The address is on the suppression list (unsubscribed)." The send checks list 4 not passed (suppression, plus quiet hours, the open HIGH ticket and auto-send off, which are recorded but do not block an approved send). Nothing was sent.
   - `08-guard-blocks-send-checks.jpg`.
5. **Quillmark (Aisha), export/cancel ticket → Draft check-in.**
   - Banner: "Sensitive: cancellation. A person always decides this; it can never be sent automatically."
   - Level: "Draft for approval · Always human".
   - `09-quillmark-sensitive-always-human.jpg`.
6. **Reject with a note:** "Rejected by Aisha Bello …: 'I'll call Grace instead of emailing'"; the email was cancelled. `10-rejected-with-note.jpg`.
7. **Dana (CS Leader) Today:** "Chase SSO setup with Pinecrest IT · Pinecrest Health — $28k ARR × escalated: Aisha Bello's task, overdue 4 days". Leo's Halden task also shows as escalated. `11-dana-today-escalated.jpg`.
8. **Priya › AI team.**
   - The page shows the three agents, their tiers and prompts, and "Auto-send is off for every agent…".
   - A Health Analyst SUCCEEDED run shows what it read, decided and did.
   - The **failed run shows as failed**: "failed (MODEL_DECLINED) … model recorded … 0 tokens · attempt 1 — This run did not succeed, so nothing it produced is shown anywhere in the product. Reason: The model declined to answer. Nothing was written in its place (D-74)."
   - Screenshots: `12-ai-team.jpg`, `13-failed-run-shown-as-failed.jpg`, `14-health-analyst-run-read-decided-did.jpg`.
9. **Priya › Audit.**
   - Filter `agent.run,approval.,outbound.` → `approval.rejected`, `approval.requested`, `outbound.refused`, `approval.approved`, `outbound.sent`, `approval.edited_approved`, `agent.run.succeeded`, ….
   - Export CSV: `audit-2026-11-03.csv`, 47 rows.
   - Then `audit.exported` lists "Exported 47 audit row(s) as CSV · Priya Raman".
   - Screenshots: `15-audit-filtered.jpg`, `16-audit-export-listed.jpg`.
10. **"AI is not configured":** the web app had no key, so the Draft check-in screen said "AI is not configured, so you write this one yourself" (e2e asserts it). The Health tab shows a narrative only when a stored SUCCEEDED run exists, and otherwise the not-configured line (`health-analyst.int` › "with no API key…").

## Deferrals (each with its home)

- Auto-send enablement UI, per-play levels, full Outreach (play steps, voice samples), Digital CSM → **M8**.
- Slack approvals and notifications (calls `requestApproval` / the decide functions with `via: "SLACK"`) → **M5**.
- Text-based signal rules from extractions, Champion Guard, Support Risk, Promise Keeper, Inbox, the full Watcher channels → **M9**.
- Meetings in Today (honest empty state now) → **M10**.
- 30/90-day checkpoints, renewal outcomes → **M7 / M11**; ledger views and AI accuracy → **M11**.
- Task completion as a linked action (tasks need a flag link) → **M8** (Q-48).
- "Draft in mailbox" level (email write-back) → **M9**.
- Live Resend verification → **M12** (or earlier with a key); live `pnpm eval` → whenever `ANTHROPIC_API_KEY` is provided.
- e2e web server on the recorded provider (test-infra change) → founder decision (Q-47).

## Known risks

- **Prompt quality before live eval:** no prompt has met a real model yet. The validators make bad answers fail closed (UNCITED, INVALID_OUTPUT, FAILED), so the first live runs may show more failures than successes until prompts are tuned against `pnpm eval`.
- **Sensitive-topic false positives:** the keyword list is deliberately wide (e.g. "cost", "incident", "terminate"). This costs a human review, never an unsafe send.
- **Number check limits:** it compares digits, so a spelled-out number ("two") is not caught. Prompts ask for numbers as written in the records.
- **The fixture transport is not a model:** the demo shows the plumbing, validation, approvals and audit end to end, not answer quality.

## Files changed

155 files against `b01fa5b` (119 added, 36 modified), including 31 golden fixtures and 15 evidence screenshots.

- **Schema:**
  - `prisma/schema.prisma`;
  - migration `20261103051529_m4_agents_approvals`.
- **Agents:** `src/modules/agents/`:
  - framework: `define`, `schemas`, `validate`, `evaluate`, `executor`, `registry`, `golden`, `jobs`, `narrative`, `checkin`, `team`, `service`;
  - `definitions/`: `health-analyst`, `health-analyst-trigger`, `watcher`, `outreach`, `index`;
  - `actions/`;
  - tests.
- **Prompts:**
  - `prompts/health-analyst.md`, `prompts/watcher-extraction.md`, `prompts/outreach.md`;
  - `prompts/__golden__/{health-analyst,outreach,extraction}/`.
- **Outbound:** `src/modules/outbound/`: `guards`, `sensitive`, `dispatch`, `service`, tests.
- **Approvals:** `src/modules/approvals/`: `level-resolver`, `lifecycle`, `proof`, `schemas`, `service`, `actions/`, tests.
- **New modules:**
  - `src/modules/today/`;
  - `src/modules/outcomes/`;
  - `src/modules/audit/`;
  - `src/modules/tasks/escalation.ts`;
  - `src/modules/conversations/extraction.ts`;
  - the Sentiment component in `src/modules/health/engine/components/index.ts`, plus the loader / type label.
- **Libraries:**
  - `src/lib/email/customerTransport.ts` and `resendHttp.ts`;
  - `src/lib/ai/` (transient vs permanent errors, refusal and invalid-output handling, `AI_RECORDINGS_DIR`);
  - `src/lib/config/env.ts`;
  - `src/lib/jobs/outbox.ts` (route `health.bandChanged`; `task.overdue` awaiting a consumer);
  - `src/lib/db/tenantModels.ts`.
- **Screens:**
  - `/today`, `/approvals`, `/approvals/[id]`, `/approvals/new`, `/agent-runs/[id]`, `/settings/audit`, `/settings/ai-team`;
  - the Health tab narrative;
  - Draft check-in links on signals and tickets;
  - task anchors;
  - notification links;
  - sign-in landing;
  - components: `ai-text`, `approval-actions`, `bulk-approvals`, `check-in-form`, `agent-switch`.
- **Worker and scripts:**
  - jobs `agents.run`, `health-analyst.consider`, `health-analyst.sweep`, `today.rebuildAll`, `tasks.escalateOverdue`, `outcomes.checkpoint`;
  - `scripts/agents-extract.ts`, `eval.ts`, `recorded-agents.ts`, `tasks-escalate.ts`.
- **Tests:**
  - the tenant, constraint, executor, guard, dispatch, approvals, Today, escalation, outcomes, audit, team and logging suites listed above;
  - e2e `m4-today-approvals.spec.ts`, `a11y-m4.spec.ts`, `support/m4.ts`.
- **Docs:**
  - DECISIONS D-74 … D-79;
  - QUESTIONS Q-46 … Q-48;
  - CLAUDE.md (AI claim, `pnpm agents:extract`, `pnpm eval`);
  - M4.md and IMPLEMENTATION_PLAN (D-35 note, checkbox);
  - CHANGELOG;
  - `.env.example` (`AI_RECORDINGS_DIR`);
  - this log;
  - `m4-evidence/`.

## What the next milestone should know

- **Adding an agent:**
  - Write `defineAgent({ key, version, modelTier, tierReason, prompt, inputSchema, outputSchema, buildContext, extraCitations?, uncited?, narrative?, forbiddenNumericFields, approvalPolicy, act? })`.
  - Add it to `definitions/index.ts`.
  - Add `prompts/<name>.md` (frontmatter name, version, agent, tier; the worker refuses to start on a mismatch).
  - Add golden cases under `prompts/__golden__/<agent>/` (replayed by `golden-replay.test.ts`; adversarial cases start "ADVERSARIAL").
  - Side effects go in `act`, keyed by `ctx.sourceKey(i)` with `createOnce`.
- **The `dispatch` contract:** `dispatch(ctx, outboundMessageId, { clock?, transport? })` returns SENT, ALREADY_SENT or HELD (automatic sends), or throws `DispatchRefusedError` with the reasons (approved sends). It records `guardResults` and audits either way. Never import the customer transport elsewhere.
- **Requesting approval:** `requestApproval(ctx, { accountId, kind, reason, proof ≥ 1, sourceKey, email? })`.
  - M5 Slack calls `approve` / `reject` with `{ via: "SLACK" }`; sensitive items are refused there by the service and the DB.
  - M8 plays pass `stepTags` (sensitive tags cap the level) and use `resolveLevel` with `stepLevel` / `safeStep`.
- **The Today section registry:** `SECTIONS` in `src/modules/today/service.ts`; add a candidate source in `todayCandidates` and a driver in `ranking.ts`.
- **Outbox events consumed:** `health.bandChanged` → `health-analyst.consider`. Still awaiting a consumer: `signal.opened`, `signal.resolved`, `task.overdue` (M8).
