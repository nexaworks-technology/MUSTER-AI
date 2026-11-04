# M9 log — Conversations, Inbox, Promises & Sentiment

> Session A (A1–A8) in progress. Session B sections are added by the next session.

## Session A — red-first evidence (kept as run)

| Slice | Test files written first | Red result (before any implementation) |
|---|---|---|
| A2 | `chunking-m9.test.ts`, `promise-party.test.ts`, `themes.test.ts` | 3 files failed: `Cannot find module '../chunk'`, `'../promise-party'`, `'../themes'` (no tests ran) |
| A2 (goldens) | `extraction-golden-m9.test.ts` | Not red by design: the M4 validator already enforced the contract, so the 52 per-kind fixtures (12 item kinds × 3 positive + 1 negative, SENTIMENT 3 + 1) pass on first run. They are regression nets, not new behaviour. |
| A3 | `extract-plan.test.ts`, `watcher-m9.int.test.ts` | `Cannot find module '../extract'`; Watcher int: 3 failed (call chunks not read, our own message labelled, prompt still 1.0.0) |
