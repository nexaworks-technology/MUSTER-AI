# M7 — Renewals, Revenue & Expansion: Log

**Status:** Session A **STOPPED after A3** on a §5 stop condition (Northgate is not LOW on honest records). A4–A7 are not started; no mid-milestone full run was made. Session B not started.
**Baseline:** `326a0cf` (M6 close + review fixes): gate 151 files / 1,456 tests, e2e 60 / 0 / 44, as reproduced by the independent review. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed). `NIGHTLY_SCHEDULES`, the fake-clock pin and every pin are untouched. No new dependencies.

## Session A (2026-11-05), slices committed

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| A1 Models | `ccae4d7` | `Renewal` (computed confidence + a separate human `forecastCategory`, author required by CHECK), `RenewalOutcome` (append-only trigger, frozen forecast snapshot, one original per renewal, corrections name what they replace), `ExpansionOpportunity` (always an estimate; a number needs a method), `Document` (an AI row names its run). RLS ENABLE + FORCE + `tenant_isolation`, composite FKs, registered. Migration `20261105100000_m7_renewals`. | `tenant-isolation-m7.int.test.ts` (real-field update with own-row control; for the append-only outcome, A→B changes 0 and A's own update is refused by the trigger; composite FKs; CHECKs); `model-registry.int.test.ts` |
| A2 Confidence | `a500ade` | `confidence.ts` (eight factors, signed points, reasons, sources; null factors excluded; clamped; banded by settings), `champion.ts`, `inputs.ts`, `riskSignalsAsOf` in signals, weights as `WorkspaceSettings.renewals`. | `confidence.test.ts` (15), `champion.test.ts` (6); settings suite unchanged |
| A3 Back-test | `f323b7a` | `runRenewalBacktest`: 12 churns + 12 renewals scored as of 90/60/30 days before each outcome from cut bundles; factor vs simple model; calibration by band and score, Brier, AUC; `calibration.ts`; fixture `confidence-backtest-seed.json`. | `calibration.test.ts` (3), `seed-renewals.int.test.ts` (4: fixture exact and repeatable, shipping rule, no look-ahead) |

## Back-test results (measured, never tuned; D-118)

Labelled set: 12 churned, 12 renewed accounts (the M3 set), 72 scored points, none unscorable. Health under the default model (v1), as in M3. Plan existence is unknowable as of a past date, so the notice factor is null here, and promises are null until M9.

| | Brier (0 best; always-50 = 0.25) | AUC (0.5 = coin) |
|---|---|---|
| Factor model, all 72 points | 0.4001 | 0.2515 |
| **Simple model (ships)**, all 72 points | **0.3433** | 0.4722 |
| Factor, 90 / 60 / 30 days | 0.4433 / 0.4390 / 0.3181 | 0.056 / 0.129 / 0.566 |
| Simple, 90 / 60 / 30 days | 0.3400 / 0.3450 / 0.3450 | 0.500 / 0.458 / 0.458 |

Calibration, all horizons pooled (renewed / churned):

| Band | Factor model | Simple model |
|---|---|---|
| HIGH (≥ 70) | 60 points: 31 / 29 | 70 points: 34 / 36 |
| MEDIUM (40–69) | 12 points: 5 / 7 | 2 points: 2 / 0 |
| LOW (< 40) | none | none |

By score, factor model: 80–100: 42 points, **13 renewed / 29 churned**; 60–79: 27 points, 23 / 4; 40–59: 3 points, 0 / 3. Factor coverage (of 72): health band, trend, signals and invoices 72; usage 61; champion 42; notice 0 (by design); promises 0.

**What it says, plainly.** At 90 and 60 days the seeded accounts are all Healthy under the default model (M3 already found it catches 0 of 12 churns), so neither model can separate them; the factor model's extra factors rank churners *above* renewers at 90 and 60 days (AUC 0.06 and 0.13), because the seed's churned accounts have full message and champion history while its renewed accounts are quiet (their champions have not written in 30+ days). Only at 30 days does the factor model carry signal (AUC 0.57). Neither model ever scores a point below 40. Both are worse than a constant 50% on this 50/50 set, which is the set's construction (12 vs 12), not a base rate. **The simple model ships** by the rule fixed beforehand (the factor model did not beat it by 0.005).

## STOP: Northgate is not LOW

M7 §5 and your rules: Northgate must assert LOW with its listed reasons; if it is not LOW on honest factors, report, never tune. On today's seeded records (as of 2026-11-02, the active health model v2):

| | Result |
|---|---|
| Health | **Healthy 88.5** (SEED_DATA §5 says "Watch trending down"; under v1 it is Healthy 89.4, down 5.1 points in 30 days) |
| Open risk signals | seats unused (60 of 158, WARN), ticket open 9 days (WARN), renewal in 41 days (INFO, not counted) |
| Invoices | LRK-1005 paid 21 days late |
| Champion | Sam Reyes, in touch |
| Notice deadline | 2026-11-13, in 11 days; no renewal plan |
| Usage | 101% of its own normal |
| Late promise, renewal-concern call | **not in the data**: no `Extraction` and no `CallTranscript` row exists for Northgate; both arrive with M9/M10 |
| **Shipped (simple) model** | base 70 + Healthy 10 − notice 10 = **70, HIGH** (exactly on the line) |
| Factor model (for reference) | **59, MEDIUM** (−4 trend, −12 two warns, −5 late invoice, −10 notice, +5 champion, +5 usage) |

Neither is LOW. Copperleaf's price is derivable (contract $36,000 and subscription $3,600,000 minor ÷ 40 seats = $900), so that stop condition is not triggered.

## Decisions added so far

D-118 (the simple model ships; the rule and the defaults), D-119 (one champion-silence definition; risk signals as of a date).

## State for the next session

Done: A1–A3 and the engine. Not done: A4 `renewals.sync` (nightly, after health; D-81 ids; outcome detection with the frozen snapshot), A5 (forecast, human category with disagreement, `/renewals`, Account 360 panel, the money-redaction helper), A6 (waterfall, billing forecast), A7 (`/revenue`, money at risk, coverage, team load, redaction enumeration test), the mid-milestone full `pnpm test`. `renewals/service.ts` is loaded on use from the pipeline (dynamic import) because the back-test reads the signals module.
