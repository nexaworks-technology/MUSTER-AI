# M9 log — Conversations, Inbox, Promises & Sentiment

> Session A (A1–A8) in progress. Session B sections are added by the next session.

## Session A — red-first evidence (kept as run)

| Slice | Test files written first | Red result (before any implementation) |
|---|---|---|
| A2 | `chunking-m9.test.ts`, `promise-party.test.ts`, `themes.test.ts` | 3 files failed: `Cannot find module '../chunk'`, `'../promise-party'`, `'../themes'` (no tests ran) |
| A2 (goldens) | `extraction-golden-m9.test.ts` | Not red by design: the M4 validator already enforced the contract, so the 52 per-kind fixtures (12 item kinds × 3 positive + 1 negative, SENTIMENT 3 + 1) pass on first run. They are regression nets, not new behaviour. |
| A3 | `extract-plan.test.ts`, `watcher-m9.int.test.ts` | `Cannot find module '../extract'`; Watcher int: 3 failed (call chunks not read, our own message labelled, prompt still 1.0.0) |
| A4 | `promise-status.test.ts`, `promise-service.test.ts`, `promise-sync.int.test.ts`, 19 fixtures in `fixtures/promise_late/` and `fixtures/promise_no_owner/` | `Cannot find module '../status'`, `'../service'`, `'@/modules/conversations/current'`; rules golden: 19 failed (no evaluator) |
| A5 | 68 fixtures in `fixtures/<ruleKey>/` for the 10 text rules, `rules-text.test.ts`, `text-signals.int.test.ts` | **Process lapse, disclosed:** the evaluators in `rules/text.ts` were written before the fixtures, so there was no natural red. Red evidence was obtained afterwards by stubbing every text evaluator to `[]` and running `rules.test.ts`: **27 failed / 196 passed** (all 27 fire cases fail, every not-fire case passes vacuously); with the real evaluators **223 / 223**. The stub was reverted before commit. |
| A6 | 29 fixtures for `champion_silent`, `champion_role_change`, `new_decision_maker`, `email_engagement_stops`; `rules-people.test.ts`; `people-signals.int.test.ts` | Fixtures written before any code: `rules.test.ts` **30 failed / 223 passed** (`Unknown rule champion_silent`, `champion_role_change`, …); after: 257 / 257. `championState` moved to `health/champion.ts` with only its two import lines changed (diff: 2 insertions, 2 deletions); `renewals/champion.ts` re-exports it; all 6 renewals suites / 37 tests unchanged and green. |

## Session A — pre-M9 test changes (standing pre-approval; every one logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/agents/__tests__/watcher.int.test.ts` (lines 108–109) | rows carry promptVersion `"1.0.0"` | `"1.1.0"` | M9.md requires the Watcher prompt version bump (full Watcher); the guard — every Extraction row records the prompt version of its run — still holds | registry/version constant (judgement call: a version string, not a count; flagged for the founder) |
| `src/modules/signals/__tests__/rule-settings.int.test.ts` | catalogue lists 23 rules | **39** (A4: `promise_late`, `promise_no_owner`; A5: 10 text rules; A6: `champion_silent`, `champion_role_change`, `new_decision_maker`, `email_engagement_stops`) | catalogue count equals registered items | count |
| `src/modules/signals/__tests__/pipeline.int.test.ts` | chunk query budget ≤ 80 | **≤ 90** (84 after A4, 89 after A5, +1 people facts in A6) | `promises.sync` (4 reads) + promise facts (1) + text facts (5) added to the evaluate chunk; the guard `queries(5 accounts) === queries(2 accounts)` still passes | budget |
