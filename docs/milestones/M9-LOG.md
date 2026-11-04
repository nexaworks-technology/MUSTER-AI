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
| Failures read together | | | (1) `seed-brief` "2 open risk signals" → 6: **D9 pre-approved** (Northgate's open signals moved because the new rules fire honestly: renewal concern, budget concern, late promise, unowned promise). (2) `seed-renewals` back-test fixture: **a cause in M9's code**: M9's 16 rules entered `riskSignalsAsOf` and moved the *factor* model's recorded numbers (97 differences, none in the shipped simple model). Fixed in code, not in the test (D-145, pinned by `as-of-m9`). (3) `seed.int` "no derived AI data": **outside the D9 list, stopped (Q-66)**. |
| Batch 1 re-run (`seed-renewals`, `seed-brief`, `seed.int`, `as-of-m9`) | 5 | 29 | 28 passed, **1 failed** (the Q-66 assertion, deliberately unedited) |

Current expected state of the full suite: **218 files; every test passes except the one `seed.int.test.ts` assertion (Q-66)**. The full gate and e2e run once, at close, in Session B.

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

1. **Q-66 — `seed.int.test.ts` "no derived AI data".** The assertion `message.count({ sentimentLabel: { not: null } }) === 0` now reads 2: the seeded Halden angry email and Marlow thank-you carry the label the real Watcher writes (D8 approved seeding extractions). Not in the D9 list, so **left failing and unedited**. One-line proposed edit and the alternative are in `docs/QUESTIONS.md`.
2. **Q-67 — Promise Late play still dormant; Engagement Loss label (D7) not changed.** Both need edits to two pre-M9 tests outside D9 (`safety.test.ts` dormant-trigger case 1; `seeded-plays.test.ts` "4 dormant plays"). The detector now exists with fixtures, so M9 rule 2's condition for waking the play is met; the code change is ready (remove `promise_late` from `DORMANT_TRIGGERS`, play live, `homeMilestone` cleared, engagement-loss relabelled "M10 (needs meetings)") and was **not applied**. Acceptance #18 depends on this.

## Session A — notes the founder should know

- **Risk 1 (health numbers):** checked, not tripped. Every account's overall score, all six pillars and risk level, and every renewal's confidence and band (Northgate's 70 and the seven-way tie included) equal the M8 baseline captured from a fresh-database seed (`prisma/seed/__tests__/fixtures/m8-health-baseline.json`). `inputsHash` is *not* comparable across seeds (14 of 60 differ between two seeds even with M9 switched off: clock-stamped dates, Q-70); that M9 adds nothing to the hash is proved at its source: only ticket-channel sentiment labels enter the bundle (`loader.ts` change, D-144, `sentiment-hash-m9.int.test.ts`).
- **A real defect found in my own work and fixed (D-145):** M9's rules were silently entering the renewal back-test's signal set and moving the factor model's recorded numbers (Rule 6). Caught by the full run, fixed by exclusion, pinned.
- **Process lapses, disclosed:** A5's evaluators were written before its fixtures (retroactive red evidence in the table above); A8's seed module was written before its test (an integration slice, not an engine module); a `prettier --write src/modules` slip reformatted ~40 unrelated files and was reverted before commit (only my files are formatted now).
- **Test database:** the disposable `nexaworks_test` database was dropped and recreated twice (`pnpm services:native`), because my own failed seed attempts left FAILED Watcher runs that cannot be deleted (audit foreign key) and block the identical retry (Q-68). A fresh clone is unaffected. The first baseline I captured on the old database was polluted by leftover accounts from other test files and was discarded; the committed baseline is from a fresh database.
- **A4 ran on Sonnet:** the plan named Opus for the promise engine; `/model` was set to Sonnet before the go, so the extra care went into tests instead (status property test, evidence rules, dedupe, a lifecycle test).
- **Tickets are read per message** (the thread), so `ExtractionSourceType.TICKET` stays unused; the "message.received / ticket.opened events" are replaced by the 15-minute `inbox.sync` job (D-143).

## State for Session B

Built and tested, no screens yet. Session B (B1–B9) can rely on:

- **Read model:** `currentExtractions(db, { kinds, accountIds })` (latest prompt version per source) from `conversations/service`; every B screen reads extractions through it.
- **Promises:** `syncPromises`, `markPromiseKept`, `sortPromises`, `promiseStatus` (`promises/service`, `promises/schemas`). Statuses, evidence and `suggestedParty` are on the row. Handoff items (B3) read `Promise` rows and AI-origin `Goal` rows; the Saltmarsh promise's party is UNCLEAR with suggestion US (show "Not clear from the text").
- **Inbox:** `receiveInboundMail`, `assignUnmatched`, `dismissUnmatched`, `syncInbox` (`inbox/service`), `InboxItem` + `UnmatchedInbound` tables, seeded Unmatched example (`seed-unmatched-1`). Sensitivity for drafts: `detectSensitive` (outbound/sensitive.ts) already maps INTENT/CANCEL/EXPORT/COMPLAINT extractions; B2 must wire it and add `sensitive-inbox.test.ts`.
- **Signals:** 16 new rules in the catalogue (categories CALLS_EMAIL, PROMISES, SUPPORT, PEOPLE); the signals list page cannot filter to CALLS_EMAIL / PROMISES yet (Q-69).
- **Health:** `sentiment_share` unchanged; the sentiment views must read Extraction (SENTIMENT rows exist for the two seeded emails and the Northgate and Brightwell calls).
- **Pending founder answers** before B can finish acceptance: Q-66, Q-67.
- **Query budgets to keep:** evaluate chunk ≤ 90 (pinned), `syncInbox` fixed reads (pinned).
- **Connectors (B6/B7)** may slip to a short third session (pre-approved). Providers and record sources already exist in the schema and `providers.ts`; `receiveInboundMail` is the intake they feed.
- **Changed to know:** `championState` lives in `health/champion.ts`; the evaluate chunk now runs `promises.sync` first; `agents:extract` / backfill now read call transcripts and outbound messages too.

## Files changed in Session A

223 files, +13.9k / −0.3k (`git diff --stat 9bce218..HEAD`), of which about 150 are fixtures (transcripts, 52 per-kind goldens, 100 rule fixtures). New modules: `src/modules/promises/`, `src/modules/inbox/`; new files in `conversations/` (chunk, extract, current, promise-party, themes, schemas), `signals/` (rules/text, rules/people, text-facts, people-facts, promise-facts); `prisma/seed/demo/extractions.ts` and its fixtures.

## Deferrals out of Session A (each with its home)

Session B: every screen (`/inbox`, Unmatched queue UI, `/promises`, Account 360 tabs, `/health/sentiment`), Support Risk Agent, reply drafts, Promise Keeper, Champion Guard, the handoff items, adapters, plays slice, e2e, the full gate and e2e, acceptance table, CHANGELOG. M10: calendar-dependent rules (`no_meeting_in_x_days` stays dormant), Engagement Loss. M12: live checks (Zendesk/Freshdesk/Gmail/Graph sandboxes, live eval `pnpm eval`, still DEFERRED without `ANTHROPIC_API_KEY`).
