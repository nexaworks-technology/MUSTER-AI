# M9 log — Conversations, Inbox, Promises & Sentiment

> Session A (A1–A8) in progress. Session B sections are added by the next session.

## Session A — red-first evidence (kept as run)

| Slice | Test files written first | Red result (before any implementation) |
|---|---|---|
| A2 | `chunking-m9.test.ts`, `promise-party.test.ts`, `themes.test.ts` | 3 files failed: `Cannot find module '../chunk'`, `'../promise-party'`, `'../themes'` (no tests ran) |
| A2 (goldens) | `extraction-golden-m9.test.ts` | Not red by design: the M4 validator already enforced the contract, so the 52 per-kind fixtures (12 item kinds × 3 positive + 1 negative, SENTIMENT 3 + 1) pass on first run. They are regression nets, not new behaviour. |
| A3 | `extract-plan.test.ts`, `watcher-m9.int.test.ts` | `Cannot find module '../extract'`; Watcher int: 3 failed (call chunks not read, our own message labelled, prompt still 1.0.0) |
| A4 | `promise-status.test.ts`, `promise-service.test.ts`, `promise-sync.int.test.ts`, 19 fixtures in `fixtures/promise_late/` and `fixtures/promise_no_owner/` | `Cannot find module '../status'`, `'../service'`, `'@/modules/conversations/current'`; rules golden: 19 failed (no evaluator) |

## Session A — pre-M9 test changes (standing pre-approval; every one logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/agents/__tests__/watcher.int.test.ts` (lines 108–109) | rows carry promptVersion `"1.0.0"` | `"1.1.0"` | M9.md requires the Watcher prompt version bump (full Watcher); the guard — every Extraction row records the prompt version of its run — still holds | registry/version constant (judgement call: a version string, not a count; flagged for the founder) |
| `src/modules/signals/__tests__/rule-settings.int.test.ts` | catalogue lists 23 rules | 25 (A4: `promise_late`, `promise_no_owner`; see later rows for A5/A6) | catalogue count equals registered items | count |
| `src/modules/signals/__tests__/pipeline.int.test.ts` | chunk query budget ≤ 80 | ≤ 84 | `promises.sync` (4 reads) + promise facts (1) added to the evaluate chunk; the guard `queries(5 accounts) === queries(2 accounts)` still passes | budget |
