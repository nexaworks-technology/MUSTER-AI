# M9 log — Conversations, Inbox, Promises & Sentiment

> **Session A (A1–A8) complete on its own terms; two items STOPPED for the founder (see "Stopped items").** Session B sections (B1–B9) are added by the next session. Nothing customer-facing was built in Session A: no screens, no navigation change (`SHIPPED_MILESTONE` stays 8).

## Session A — what was built

| Slice | Commit | What it is | Evidence |
|---|---|---|---|
| A1 Schema | `7c45c4b` | `Promise`, `InboxItem` (triage only), `UnmatchedInbound` (RLS, composite FKs, DB checks: AI promise carries quote + extraction + run; KEPT carries evidence; assigned/dismissed holding row keeps no text); `Extraction.chunkIndex` in the unique key; `Goal.extractionId` (unique, AI only); `Contact.previousTitle/titleChangedAt` by trigger; providers ZENDESK, FRESHDESK, GOOGLE_EMAIL, MICROSOFT_EMAIL. Migration `20261107100000_m9_conversations`. | `tenant-isolation-m9.int.test.ts` (real-field update/delete attacks with own-row controls, raw-SQL, cross-tenant FKs, the CHECKs, chunks, the title trigger), `model-registry.int.test.ts` (3 new [W] models) |
| A2 Extraction gaps | `270c4d2` | Transcript chunker, who-promised (code decides, model hint only a suggestion), fixed theme list, 52 per-kind golden fixtures | `chunking-m9` (8), `promise-party` (10), `themes` (3), `extraction-golden-m9` (53) |
| A3 Watcher full | `64a3ad3` | Watcher 1.1.0 over messages (both directions), notes, call chunks; `conversations.reextract` (ids only, refused when stale or nothing earlier read); 15-minute `extractSweep` | `extract-plan` (9), `watcher-m9.int` (4), no log line carries the text (asserted) |
| A4 Promise engine | `e772763` | `promiseStatus`, `syncPromises` (promises, AI goals, statuses; in the evaluate chunk), `markPromiseKept` (audited), `promise_late`, `promise_no_owner` | `promise-status` (11), `promise-service` (4), `promise-sync.int` (10), 19 golden fixtures |
| A5 Text rules | `e6749a7` | 10 text rules, text facts loader, themes as a workspace setting | 68 fixtures, `rules-text` (5), `text-signals.int` (6) |
| A6 People rules | `78893fb` | `champion_silent` (reuses `championState`, moved to `health/champion.ts`), `champion_role_change`, `new_decision_maker`, `email_engagement_stops` | 29 fixtures, `rules-people` (4), `people-signals.int` (1), renewals suites unchanged |
| A7 Inbox | `8f8df73` | Matching, intake, Unmatched assign/dismiss (audited), bounce handling, `syncInbox`, `inbox.sync` job | `matching` (13), `inbox.int` (15, incl. no-N+1 and cross-workspace) |
| A8 Seed | `9e1b900` | Real Watcher over recorded answers for the story sources, Northgate promise line, Saltmarsh CRM note, Unmatched example, ticket-only health labels | `seed-m9.int` (17), `sentiment-hash-m9.int` (2) |
| Close fixes | (this commit) | M9 rules excluded from the renewal back-test (D-145), approved D9 count, docs | `as-of-m9` (2), `seed-renewals`, `seed-brief` green |

## Session A — the one mid-milestone full `pnpm test`

Run once, after A8 and before the close fixes (nothing edited during the run), then **only the failed suites re-run** (batch 1 of the allowed 2):

| | Files | Tests | Result |
|---|---|---|---|
| Baseline (M8 close) | 200 | 1,840 | green |
| Full run | 218 | 2,163 | **3 failed**, 215 files / 2,160 tests passed (288 s) |
| Failures read together | | | (1) `seed-brief` "2 open risk signals" → 6: **D9 pre-approved** (Northgate's open signals moved because the new rules fire honestly: renewal concern, budget concern, late promise, unowned promise). (2) `seed-renewals` back-test fixture: **a cause in M9's code**: M9's 16 rules entered `riskSignalsAsOf` and moved the *factor* model's recorded numbers (97 differences, none in the shipped simple model). Fixed in code, not in the test (D-145, pinned by `as-of-m9`). (3) `seed.int` "no derived AI data": **outside the D9 list, stopped (Q-73)**. |
| Batch 1 re-run (`seed-renewals`, `seed-brief`, `seed.int`, `as-of-m9`) | 5 | 29 | 28 passed, **1 failed** (the Q-73 assertion, deliberately unedited) |

Current expected state of the full suite: **218 files; every test passes except the one `seed.int.test.ts` assertion (Q-73)**. The full gate and e2e run once, at close, in Session B.

## Session A — red-first evidence (kept as run)

| Slice | Test files written first | Red result (before any implementation) |
|---|---|---|
| A2 | `chunking-m9.test.ts`, `promise-party.test.ts`, `themes.test.ts` | 3 files failed: `Cannot find module '../chunk'`, `'../promise-party'`, `'../themes'` (no tests ran) |
| A2 (goldens) | `extraction-golden-m9.test.ts` | Not red by design: the M4 validator already enforced the contract, so the 52 per-kind fixtures (12 item kinds × 3 positive + 1 negative, SENTIMENT 3 + 1) pass on first run. They are regression nets, not new behaviour. |
| A3 | `extract-plan.test.ts`, `watcher-m9.int.test.ts` | `Cannot find module '../extract'`; Watcher int: 3 failed (call chunks not read, our own message labelled, prompt still 1.0.0) |
| A4 | `promise-status.test.ts`, `promise-service.test.ts`, `promise-sync.int.test.ts`, 19 fixtures in `fixtures/promise_late/` and `fixtures/promise_no_owner/` | `Cannot find module '../status'`, `'../service'`, `'@/modules/conversations/current'`; rules golden: 19 failed (no evaluator) |
| A5 | 68 fixtures in `fixtures/<ruleKey>/` for the 10 text rules, `rules-text.test.ts`, `text-signals.int.test.ts` | **Process lapse, disclosed:** the evaluators in `rules/text.ts` were written before the fixtures, so there was no natural red. Red evidence was obtained afterwards by stubbing every text evaluator to `[]` and running `rules.test.ts`: **27 failed / 196 passed** (all 27 fire cases fail, every not-fire case passes vacuously); with the real evaluators **223 / 223**. The stub was reverted before commit. |
| A6 | 29 fixtures for `champion_silent`, `champion_role_change`, `new_decision_maker`, `email_engagement_stops`; `rules-people.test.ts`; `people-signals.int.test.ts` | Fixtures written before any code: `rules.test.ts` **30 failed / 223 passed** (`Unknown rule champion_silent`, `champion_role_change`, …); after: 257 / 257. `championState` moved to `health/champion.ts` with only its two import lines changed (diff: 2 insertions, 2 deletions); `renewals/champion.ts` re-exports it; all 6 renewals suites / 37 tests unchanged and green. |
| A7 | `matching.test.ts` (13), `inbox.int.test.ts` (15) | `Cannot find module '../matching'`, then `'../service'` (no tests ran); green: 13 + 15 |

## Session A — pre-M9 test changes (standing pre-approval; every one logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/agents/__tests__/watcher.int.test.ts` (lines 108–109) | rows carry promptVersion `"1.0.0"` | `"1.1.0"` | M9.md requires the Watcher prompt version bump (full Watcher); the guard — every Extraction row records the prompt version of its run — still holds | registry/version constant (judgement call: a version string, not a count; flagged for the founder) |
| `src/modules/signals/__tests__/rule-settings.int.test.ts` | catalogue lists 23 rules | **39** (A4: `promise_late`, `promise_no_owner`; A5: 10 text rules; A6: `champion_silent`, `champion_role_change`, `new_decision_maker`, `email_engagement_stops`) | catalogue count equals registered items | count |
| `prisma/seed/__tests__/seed-brief.int.test.ts` (line 44) | Northgate's brief says "2 open risk signals" | "6 open risk signals" | the seeded open-signal count for Northgate moves because the new rules fire honestly (D9, exactly as listed) | **D9 listed** |
| `src/modules/signals/__tests__/pipeline.int.test.ts` | chunk query budget ≤ 80 | **≤ 90** (84 after A4, 89 after A5, +1 people facts in A6) | `promises.sync` (4 reads) + promise facts (1) + text facts (5) added to the evaluate chunk; the guard `queries(5 accounts) === queries(2 accounts)` still passes | budget |

## Session A — stopped items (founder decision needed; nothing worked around)

1. **Q-73 — `seed.int.test.ts` "no derived AI data".** The assertion `message.count({ sentimentLabel: { not: null } }) === 0` now reads 2: the seeded Halden angry email and Marlow thank-you carry the label the real Watcher writes (D8 approved seeding extractions). Not in the D9 list, so **left failing and unedited**. One-line proposed edit and the alternative are in `docs/QUESTIONS.md`.
2. **Q-74 — Promise Late play still dormant; Engagement Loss label (D7) not changed.** Both need edits to two pre-M9 tests outside D9 (`safety.test.ts` dormant-trigger case 1; `seeded-plays.test.ts` "4 dormant plays"). The detector now exists with fixtures, so M9 rule 2's condition for waking the play is met; the code change is ready (remove `promise_late` from `DORMANT_TRIGGERS`, play live, `homeMilestone` cleared, engagement-loss relabelled "M10 (needs meetings)") and was **not applied**. Acceptance #18 depends on this.

## Session A — notes the founder should know

- **Risk 1 (health numbers):** checked, not tripped. Every account's overall score, all six pillars and risk level, and every renewal's confidence and band (Northgate's 70 and the seven-way tie included) equal the M8 baseline captured from a fresh-database seed (`prisma/seed/__tests__/fixtures/m8-health-baseline.json`). `inputsHash` is *not* comparable across seeds (14 of 60 differ between two seeds even with M9 switched off: clock-stamped dates, Q-77); that M9 adds nothing to the hash is proved at its source: only ticket-channel sentiment labels enter the bundle (`loader.ts` change, D-144, `sentiment-hash-m9.int.test.ts`).
- **A real defect found in my own work and fixed (D-145):** M9's rules were silently entering the renewal back-test's signal set and moving the factor model's recorded numbers (Rule 6). Caught by the full run, fixed by exclusion, pinned.
- **Process lapses, disclosed:** A5's evaluators were written before its fixtures (retroactive red evidence in the table above); A8's seed module was written before its test (an integration slice, not an engine module); a `prettier --write src/modules` slip reformatted ~40 unrelated files and was reverted before commit (only my files are formatted now).
- **Test database:** the disposable `nexaworks_test` database was dropped and recreated twice (`pnpm services:native`), because my own failed seed attempts left FAILED Watcher runs that cannot be deleted (audit foreign key) and block the identical retry (Q-75). A fresh clone is unaffected. The first baseline I captured on the old database was polluted by leftover accounts from other test files and was discarded; the committed baseline is from a fresh database.
- **A4 ran on Sonnet:** the plan named Opus for the promise engine; `/model` was set to Sonnet before the go, so the extra care went into tests instead (status property test, evidence rules, dedupe, a lifecycle test).
- **Tickets are read per message** (the thread), so `ExtractionSourceType.TICKET` stays unused; the "message.received / ticket.opened events" are replaced by the 15-minute `inbox.sync` job (D-143).

## State for Session B

Built and tested, no screens yet. Session B (B1–B9) can rely on:

- **Read model:** `currentExtractions(db, { kinds, accountIds })` (latest prompt version per source) from `conversations/service`; every B screen reads extractions through it.
- **Promises:** `syncPromises`, `markPromiseKept`, `sortPromises`, `promiseStatus` (`promises/service`, `promises/schemas`). Statuses, evidence and `suggestedParty` are on the row. Handoff items (B3) read `Promise` rows and AI-origin `Goal` rows; the Saltmarsh promise's party is UNCLEAR with suggestion US (show "Not clear from the text").
- **Inbox:** `receiveInboundMail`, `assignUnmatched`, `dismissUnmatched`, `syncInbox` (`inbox/service`), `InboxItem` + `UnmatchedInbound` tables, seeded Unmatched example (`seed-unmatched-1`). Sensitivity for drafts: `detectSensitive` (outbound/sensitive.ts) already maps INTENT/CANCEL/EXPORT/COMPLAINT extractions; B2 must wire it and add `sensitive-inbox.test.ts`.
- **Signals:** 16 new rules in the catalogue (categories CALLS_EMAIL, PROMISES, SUPPORT, PEOPLE); the signals list page cannot filter to CALLS_EMAIL / PROMISES yet (Q-76).
- **Health:** `sentiment_share` unchanged; the sentiment views must read Extraction (SENTIMENT rows exist for the two seeded emails and the Northgate and Brightwell calls).
- **Pending founder answers** before B can finish acceptance: Q-73, Q-74.
- **Query budgets to keep:** evaluate chunk ≤ 90 (pinned), `syncInbox` fixed reads (pinned).
- **Connectors (B6/B7)** may slip to a short third session (pre-approved). Providers and record sources already exist in the schema and `providers.ts`; `receiveInboundMail` is the intake they feed.
- **Changed to know:** `championState` lives in `health/champion.ts`; the evaluate chunk now runs `promises.sync` first; `agents:extract` / backfill now read call transcripts and outbound messages too.

## Files changed in Session A

223 files, +13.9k / −0.3k (`git diff --stat 9bce218..HEAD`), of which about 150 are fixtures (transcripts, 52 per-kind goldens, 100 rule fixtures). New modules: `src/modules/promises/`, `src/modules/inbox/`; new files in `conversations/` (chunk, extract, current, promise-party, themes, schemas), `signals/` (rules/text, rules/people, text-facts, people-facts, promise-facts); `prisma/seed/demo/extractions.ts` and its fixtures.

## Deferrals out of Session A (each with its home)

Session B: every screen (`/inbox`, Unmatched queue UI, `/promises`, Account 360 tabs, `/health/sentiment`), Support Risk Agent, reply drafts, Promise Keeper, Champion Guard, the handoff items, adapters, plays slice, e2e, the full gate and e2e, acceptance table, CHANGELOG. M10: calendar-dependent rules (`no_meeting_in_x_days` stays dormant), Engagement Loss. M12: live checks (Zendesk/Freshdesk/Gmail/Graph sandboxes, live eval `pnpm eval`, still DEFERRED without `ANTHROPIC_API_KEY`).

# Session B

## Session B — pre-M9 test changes (founder-approved at the start of Session B; every one logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `prisma/seed/__tests__/seed.int.test.ts` ("stores every planted line verbatim…") | seeded messages with a sentiment label: 0 | 2 | Halden's angry email and Marlow's thank-you carry the label the real Watcher wrote (D8); derived, not planted; ticket threads stay unlabelled | founder-approved (Q-73) |
| `src/modules/plays/__tests__/safety.test.ts` (dormant-trigger, case 1) | `promise_late` refused, naming M9 | `promise_late` has no dormancy refusal | M9 rule 2: the detector exists, so the play's dormancy ends | founder-approved (Q-74) |
| `src/modules/plays/__tests__/seeded-plays.test.ts` | "11 live" (promise-late absent); "4 dormant" incl. promise-late (M9) and engagement-loss (M9/M10) | "12 live" incl. promise-late; "3 dormant"; engagement-loss milestone "M10 (needs meetings)" | same; D7 relabel | founder-approved (Q-74) |

Code with them: `promise_late` removed from `DORMANT_TRIGGERS`; Promise Late seeded live (still DRAFT until a human publishes); Engagement Loss relabelled; `seedPlaysForWorkspace` relabels a still-DRAFT, version-1 play of those two keys in existing workspaces (a workspace's edits are never overwritten). New test: `promise-late-play.int.test.ts` (acceptance #18: both plays pass the safety check; Promise Late publishes and enters on a `promise_late` signal).

Question numbers: M9's Session A questions (Q-66–Q-70) collided with M6's Q-66/Q-68 and are renumbered **Q-73–Q-77** in `QUESTIONS.md`, `DECISIONS.md` and this log (Q-73 seed sentiment assertion, Q-74 Promise Late wake, Q-75 failed Watcher runs final, Q-76 signals category filter, Q-77 `inputsHash` unstable across seeds).

## Session B — red-first evidence (written and run BEFORE the implementation)

| Slice | Test files written first | Red result |
|---|---|---|
| B1 | `labels.test.ts`, `inbox/__tests__/list.int.test.ts` (8), `conversation-labels.int.test.ts` (4) | `Cannot find module '../labels'`; `listInbox is not a function`; labels `undefined` on every message |
| B2 | `support-risk.int.test.ts` (5), `outbound/__tests__/sensitive-inbox.test.ts` (6) | `Cannot find module '../definitions/support-risk'` for both files; no tests ran |

Pre-M9 test change (registry constant, standing pre-approval): `src/modules/agents/__tests__/team.int.test.ts` agent list: 9 agents → adds `support-risk` (B2; B3 adds `promise-keeper`, B4 `champion-guard`, final list in the last row of the table in B9).
| B3 | `promise-surfaces.int.test.ts` (7), 6 new cases in `handoff.test.ts`, `brief-promises.test.ts` (3), `promise-keeper.int.test.ts` (4), `evidence-m9.int.test.ts` (1) | `createPromise/listPromises/... is not a function`; handoff: `promises_made` item missing (6 failed); brief: old "not connected yet" text; `Cannot find module '../definitions/promise-keeper'`; evidence links without href |

## Session B — pre-M9 test changes, continued (D9 list and standing pre-approval)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/documents/__tests__/renewal-brief.test.ts` ("promise status…") | text matches "not connected yet" | matches "No promises on file" (no promise data on the facts) | the brief's promise metric is real (new briefs only); with none on file it says so | D9 listed |
| `prisma/seed/__tests__/seed-brief.int.test.ts` | `promises.status` matches "not connected yet" | matches "1 promise made: 1 late, 0 open, 0 kept" (Northgate's late promise) | same | D9 listed |
| `src/modules/renewals/__tests__/confidence.test.ts` | reason matches "Promise tracking starts in M9" | matches "Late promises are not counted by the shipped model" | display text only; the factor stays at 0 points, unwired (rule 6) | D9 listed |
| `src/modules/onboarding/__tests__/handoff.test.ts` ("has no promises item in M6") | no item whose key includes "promise" | the `promises_made` item exists and says "Not found in CRM" when there are none | M9.md #20 removes the M6 log-only line; this one case pinned the absence (same file as D9's added handoff cases; flagged for ratification) | D9 file, one existing case |
| B4 | `champion-candidates.test.ts` (8), `champion-guard.int.test.ts` (7) | `Cannot find module '../champion-candidates'` / `'../champion-guard.service'` (no tests ran) |
| B5 | `sentiment/__tests__/sentiment.int.test.ts` (7) | `Cannot find module '../service'` (no tests ran) |

## Session B — full e2e, batch 1 (cause read from all three failures first)

Full `pnpm test:e2e` (the one): **69 passed / 3 failed / 65 skipped** (baseline 75 / 0 / 55 plus the M9 files; the skip count grows because M9's flow specs are desktop-only and the serial flow stops after a failure). All three failures read together before any edit:

| Failure | Cause | Fix |
|---|---|---|
| `m4-today-approvals` "Draft check-in on the usage drop…" expected level text "Draft for approval", got "Draft for approval · Always human" | The M9 seed gave Brightwell a COMPLAINT extraction (a call line about flaky reports); M8's gate flags every draft to an account with a complaint on record as sensitive. A seed-data side effect in M9's own code, not a behaviour to change | Seed answer for that call line is a THEME (the same quote), not a COMPLAINT: reports being flaky is a problem theme, not a complaint to us. No pre-M9 test touched |
| `m7-renewals-revenue` Northgate brief expected "2 open risk signals" | **D9 listed**: Northgate's seeded open-signal count moved because the new rules fire honestly (same cause as `seed-brief`); the same spec also pins "not connected yet" for the promise metric (**D9 listed**) | e2e expectations → "6 open risk signals" and "1 promise made: 1 late, 0 open, 0 kept" |
| `m9-inbox-promises` Quillmark: `SENT` count expected 0, got 1 | My own assertion was wrong in a shared database: the M4 spec earlier in the run legitimately sends one message through dispatch | The assertion now compares the message count before and after the click |

## Session B — what was built

| Slice | Commit | What it is | Evidence |
|---|---|---|---|
| Approvals | `80a3269` | Three founder-approved test edits, Promise Late live, Engagement Loss relabelled, question renumbering | `promise-late-play.int.test.ts` (2), `seeded-plays`, `safety`, `seed.int` |
| B1 | `503946a` | `/inbox`, Unmatched queue (assign / dismiss, audited), Account 360 › Conversations labels from Extraction | `labels` (14), `list.int` (8), `conversation-labels.int` (4); both query-budget tests (2 vs 5, 2 vs 8) |
| B2 | `20a6ba2` | Support Risk Agent; inbox reply drafts through Approvals; sensitive gate by construction | `support-risk.int` (5), `sensitive-inbox.test` (6 inbound topics: draft only, capped, AUTO dispatch sends nothing, DB refuses the lift) |
| B3 | `9f5e079` | `/promises` + account tab, manual entry / owner / kept-with-note, Promise Keeper, handoff promises, brief promise metric, signal evidence links | `promise-surfaces.int` (7), `handoff.test` (+6), `brief-promises` (3), `promise-keeper.int` (4), `evidence-m9.int` (1) |
| B4 | `138c1a2` | Champion Guard: ranked candidates by code, agent drafts one intro, People-tab card | `champion-candidates` (8), `champion-guard.int` (7) |
| B5 | `e13b7a9` | `/health/sentiment`, account tone panel | `sentiment.int` (7) incl. query budget |
| B6, B7 | — | **Not built: the pre-approved slip to a third session (D-150, Q-79)** | — |
| B8 | `642a080` | Nav (Inbox, Promises), `SHIPPED_MILESTONE = 9`, the M9 row in `features.test.ts` only, `e2e/m9-inbox-promises.spec.ts` (10), `e2e/a11y-m9.spec.ts` | targeted e2e green (desktop 10/10, axe desktop + 375 px) |
| Close | `43806df`, `729bc63`, `bd5d39a`, this commit | Fresh-database demo scripts, fixes from the close runs, docs | below |

## Session B — red-first evidence

Written and run **before** the implementation, in the table above ("Session B — red-first evidence"): B1 (three files red), B2 (`Cannot find module '../definitions/support-risk'`), B3 (16 failures + two missing modules), B4 and B5 (modules missing). No lapse this session. B8 (screens, e2e) and the close fixes are integration work, not engine modules.

## Close — the Tier-2 pair

| Run | Result |
|---|---|
| **One full `pnpm test:e2e`** | 69 passed / **3 failed** / 65 skipped (3.3 min). All three read together, then fixed (table "full e2e, batch 1" above): a seed side effect in M9's own code (Brightwell's flaky-reports line recorded as a complaint made M4's draft sensitive: it is a theme now), the **D9-listed** Northgate counts in the M7 spec, and my own sent-count assertion. Batch 1 re-run of only those three files on a re-seeded test database: **26 passed / 0 failed** |
| **One full `pnpm gate`** | typecheck ✓, lint ✓ (0 warnings; secret scan 1,271 files, none), **tests 232 files / 2,254: 2,251 passed, 3 failed** (all mine, read together: `seed-m9` run count and renewal comparison counted rows other specs add in the shared database; the title-change trigger stored the server's local clock on this UTC+5:30 machine). Batch 1: new migration `20261107110000_m9_title_trigger_utc`, both seed checks restricted to the seed's own rows; re-run of only the failed files (`seed-m9`, `people-signals`, `tenant-isolation-m9`, `model-registry`) **176 / 176 passed**. Build ✓ (46 static routes; `/inbox`, `/inbox/unmatched`, `/promises`, `/accounts/[id]/promises`, `/health/sentiment` compiled) |
| Failure batches used | e2e 1 of 2, gate 1 of 2. No product-logic, spec or founder-decision failure |

**Regression statement.** Against the M8 baseline (gate 200 files / 1,840 tests; e2e 75 / 0 / 55) and Session A's mid-run (218 files / 2,163): the gate is 232 files / 2,254 tests, every pre-M9 test passes except the edits logged in the tables above (three founder-approved, the D9-listed ones, the standing-rule counts); e2e passes with the same logged edits. No assertion was loosened to get green: each edit states file, old, new, reason.

**Risk 1, repeated at close.** On a brand-new scratch database seeded with the final code (`docs/milestones/m9-evidence/demo-fresh-db.txt`): snapshots matching the M8 baseline (overall, adoption, sentiment, risk level) **60 of 60**; renewal confidences **58 of 58**; Northgate **70 (HIGH)**; the full set (all six pillars, band, the seven-way tie) is asserted by `seed-m9.int.test.ts`, green in the gate. Nothing moved.

## Fresh-database demo (M9.md §7), on a new scratch database

`pnpm exec tsx --env-file=.env scripts/demo-m9.ts` (creates `nexaworks_scratch_m9_<ts>`, migrates, seeds, runs, drops it; recorded in `docs/milestones/m9-evidence/demo-fresh-db.txt`):

1. The real Watcher (1.1.0) read Halden's call: the PROMISE extraction's quote is verbatim in the call text (checked), and no story-source run dropped a quote.
2. Halden's promise reads **LATE: 9 days late**, with its call quote as proof.
3. Promise Late was DRAFT, **publishes**, and **enters on the open `promise_late` signal** (1 run).
4. A reply drafted from Quillmark's cancel-and-export ticket: approval **PENDING, DRAFT_FOR_APPROVAL, sensitive (cancellation)**; the draft cites the customer's message; forcing it to AUTO dispatch is **HELD, 0 emails sent**.
5. Northgate: late promise (3 days) with its quote, `renewal_concern` CRITICAL and `budget_concern` WARN, each citing the call and its quote; confidence still 70.

## Acceptance table

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** (with one failure batch) | above |
| 2 | `pnpm test:e2e` incl. `m9-inbox-promises.spec.ts` | **PASS** (with one failure batch) | above; desktop 10/10 |
| 3 | Invented / paraphrased quotes dropped | PASS | `extraction-validate.test.ts`, 52 negative goldens, seed run: 0 dropped |
| 4 | Golden replay for every kind | PASS | 13 kinds × 4 fixtures (3 positive + 1 negative each) in `extraction-golden-m9` |
| 5 | Live extraction eval | **DEFERRED** | no `ANTHROPIC_API_KEY`; `pnpm eval` prints DEFERRED |
| 6 | Every new rule has fire + not-fire fixtures | PASS | `fixtures/<rule>/`: promise_late 11, promise_no_owner 8, competitor 8, budget 4, cancel 4, export 3, complaint_repeated 8, repeat_problem 8, angry 8, renewal_concern 4, no_reply 8, goal_stated 3, champion_silent 11, role_change 7, new_decision_maker 5, email_engagement_stops 7 |
| 7 | Inbound cancel/export never auto-replies | PASS | `sensitive-inbox.test.ts` (6 topics), e2e Quillmark, demo step 4 |
| 8 | Unmatched mail never on a wrong account | PASS | `matching.test.ts` (13), `inbox.int.test.ts`, e2e Unmatched |
| 9 | Late promises first; rows carry quote + source | PASS | `promise-service`, `promise-surfaces.int`, e2e `/promises`; screenshot not taken (the e2e asserts the text and link) |
| 10 | Every theme ≥ 1 quote with a source link | PASS | `sentiment.int` (every theme), e2e (every theme on the page) |
| 11 | AI text backed by a SUCCEEDED run with citations | PASS | DB CHECKs: AI promise, goal, extraction carry run + quote; drafts, tasks and approvals name `agentRunId`; UNCITED runs write nothing (tested) |
| 12 | Adapters read-only; draft-in-mailbox refused without write-back | **NOT BUILT** | B6/B7 slipped (D-150) |
| 13 | Adapter contract tests on recorded fixtures | **NOT BUILT** | same |
| 14 | Live sandbox sync Zendesk/Freshdesk/Gmail/Graph | **DEFERRED** (and not built) | no sandbox credentials; adapters pending |
| 15 | Tenant suite covers Promise, InboxItem, Extraction, Goal | PASS | `tenant-isolation-m9.int.test.ts` (+ UnmatchedInbound) |
| 16 | Screens within query budgets | PASS | inbox list, promises list, sentiment, conversation labels, inbox sync, evaluate chunk (≤ 90): equal counts at 2 vs 5 (or 8) |
| 17 | axe on inbox, promises, sentiment at desktop + 375 px | PASS | `a11y-m9.spec.ts`, both projects |
| 18 | Promise Late + Champion Loss pass the safety check | PASS | `promise-late-play.int.test.ts`, Plays screen; demo step 3 |
| 19 | No secrets in repo or logs | PASS, with a finding | scan clean (1,271 files); **Q-78**: M8's demo script held real local DB passwords (now read from env; still in git history) |
| 20 | Sales handoff lists promises and call goals with sources; absent ones "Not found in CRM" | PASS (tests) | `handoff.test.ts` (+6). The panel renders items generically; not separately screenshotted on Saltmarsh |

**Per-connector status:** Zendesk, Freshdesk, Gmail, Microsoft Graph: **not built** (pre-approved slip, D-150). What exists: providers and sources in the schema, `receiveInboundMail` + matching + bounce handling + the Unmatched queue they feed, recorded-fixture machinery from M5. Live checks: DEFERRED.

## Session B — decisions and questions added

D-147–D-150 in `DECISIONS.md`; Q-78–Q-81 in `QUESTIONS.md` (the Session A questions are Q-73–Q-77 after the renumbering).

## Session B — deferrals

- **Third session (short): B6 + B7.** Brief: `NormalizedBatch` gains `tickets` and `mail` kinds and a conversation ingest beside `ingest.service.ts` (matched → Conversation + Message + Ticket via `ExternalRef`; unmatched tickets → `UnmatchedInbound`; **mailbox mail with no known contact or account domain is discarded without being stored**, D3); Zendesk (API token, incremental cursor, HMAC webhook), Freshdesk (API key; no native webhook signing, so refuse unless a shared-secret header matches: log it), Gmail (OAuth, history cursor), Graph (OAuth, delta token); recorded fixtures labelled "authored from docs, not captured"; contract tests; `describeError`; "draft in mailbox" refused without write-back (D-116, Q-23). Then the close pair again, the acceptance rows 12–14, the plan checkbox, and M9 is marked complete.
- M10: calendar-dependent rules, Engagement Loss, QBR Due, Business Review Follow-up; extraction entry point for call summaries is `watcher` (`runAgent` with `{ sourceType: "CALL_TRANSCRIPT", chunkIndex }`) and `chunkTranscript` (`conversations/service`); kinds with weak precision: not measured (no live eval).
- M12: live checks; Q-80 / Q-81 when you decide.

## Session B — notes

- **The plan checkbox stays unticked** (`IMPLEMENTATION_PLAN.md`): M9 is not complete until acceptance #12–#14 are met.
- One existing M6 handoff case was replaced (it pinned "no promises item"); the other pre-M9 edits are logged above. The `watcher` prompt bump invalidated the M4 e2e recordings for the Watcher without breaking a spec (the specs do not depend on them).
- Dropped and recreated the disposable `nexaworks_test` database twice more (a stale Brightwell extraction and the e2e leftovers); it is regenerated by the test setup.

# Connectors Session (Finishing M9)

## Slice 0 — Q-78 security tidy

- **Scanner pattern:** added `db-password` pattern in `scripts/secret-patterns.ts` covering hardcoded DB password string literal assignments (the shape committed in `scripts/demo-fresh-db.ts`, commit `712d626`).
- **Scanner test:** `scripts/__tests__/secret-patterns-m9.test.ts` proves the pattern fires on fixture strings and does not fire on the env-reading code.
- **Password rotation:** Generated new local development database passwords. Applied to local Postgres roles `nexaworks_owner` and `app_user`. Updated `docker/postgres/roles.sql` with `ALTER ROLE ... WITH PASSWORD` so `pnpm services:native` idempotently keeps roles synchronized with `.env`. Updated project `.env`.
- **Verification:** `pnpm services:native` ran cleanly; targeted test suite `src/lib/audit/__tests__/audit.int.test.ts` passed (4/4); demo scripts continue to read from environment variables. Password rotation succeeded.
- **Git history note:** The old passwords remain in git history; the repo is local-only and has never been pushed; git history scrub is a precondition of any future push (homed to M12).

## Slice B6 — Zendesk & Freshdesk adapters

- **Red-first evidence:**
  - `src/modules/integrations/adapters/zendesk/__tests__/contract.test.ts` failed before implementation with `Cannot find module '..'`.
  - `src/modules/integrations/adapters/freshdesk/__tests__/contract.test.ts` failed before implementation with `Cannot find module '..'`.
  - `src/modules/integrations/__tests__/support-connectors.int.test.ts` failed with missing adapter and missing fixtures.
- **What was built:**
  - Zendesk adapter: basic auth (email + token), incremental tickets export, HMAC-SHA256 webhook signature verification with 300s tolerance, payload mapping to `NormalizedTicket`.
  - Freshdesk adapter: basic auth (key + X), tickets query with conversations, shared-secret webhook header verification (conservative reading per Q-82), payload mapping to `NormalizedTicket`.
  - `ingestTickets` in `src/modules/integrations/ingest-conversations.ts` mapped via `ExternalRef` into `Ticket`, `Conversation`, `Message`, and `InboxItem`. Unmatched tickets land in `UnmatchedInbound`.
  - Settings › Integrations cards updated with Support category and setup instructions.
  - Recorded fixtures labelled `"authored from docs, not captured"`.
  - Sync-twice proof: Second sync with same fixture creates 0 rows, updates 0 rows, marks all as unchanged.
- **Evidence:** `contract.test.ts` (Zendesk: 5/5, Freshdesk: 5/5), `support-connectors.int.test.ts` (3/3), `pnpm test src/modules/integrations` (27 files / 193 tests passed).

## Slice B7 — Gmail & Microsoft Graph email adapters

- **Red-first evidence:**
  - `src/modules/integrations/adapters/google-email/__tests__/contract.test.ts` failed before implementation with `Cannot find module '..'`.
  - `src/modules/integrations/adapters/microsoft-email/__tests__/contract.test.ts` failed before implementation with `Cannot find module '..'`.
  - `src/modules/integrations/__tests__/email-connectors.int.test.ts` failed initially on missing adapters and write-back gate refusal.
- **What was built:**
  - Gmail adapter (`google-email`): OAuth2 authorization, exchange, and refresh; read-only message polling mapping RFC headers and body to `NormalizedMail`; mailbox draft creation via `writeBack` with field `"draft"`; error mapping via `describeProviderError`.
  - Microsoft Graph adapter (`microsoft-email`): OAuth2 authorization, exchange, and refresh; read-only message polling with delta query mapping to `NormalizedMail`; mailbox draft creation via `writeBack` with field `"draft"`; error mapping via `describeProviderError`.
  - Hard privacy rule: Only email matching a known contact email or account domain is kept (`matchSender`); all unmatched email is discarded without being stored (0 Message rows, 0 UnmatchedInbound rows, 0 Conversation rows).
  - Write-back gate: "Draft in mailbox" is refused when write-back is disabled on the integration (`WriteBackRefusedError`), and refused over live transport without `WRITE_BACK_LIVE=true` per D-116.
  - Settings › Integrations cards updated with Email category and OAuth connect links; queue payload hygiene preserved (job payloads contain ids only, message bodies remain on record rows).
  - Recorded fixtures labelled `"authored from docs, not captured"`.
  - Sync-twice proof: Second sync with same fixture creates 0 rows, marks all as unchanged.
- **Evidence:** `contract.test.ts` (Gmail: 6/6, Graph: 6/6), `email-connectors.int.test.ts` (3/3), full integrations test suite passed (30 files / 208 tests).



