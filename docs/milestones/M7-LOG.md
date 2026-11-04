# M7 — Renewals, Revenue & Expansion: Log

**Status:** Session A **STOPPED after A4** on the founder's condition for the Northgate assertion (it must rank lowest in the next 90 days; it does not: a seven-way tie, see below). Earlier, after A3, the founder accepted the simple model and the "lowest in the window" demo. A5–A7 are not started; no mid-milestone full run was made. Session B not started.
**Baseline:** `326a0cf` (M6 close + review fixes): gate 151 files / 1,456 tests, e2e 60 / 0 / 44, as reproduced by the independent review. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed). `NIGHTLY_SCHEDULES`, the fake-clock pin and every pin are untouched. No new dependencies.

## Session A (2026-11-05), slices committed

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| A1 Models | `ccae4d7` | `Renewal` (computed confidence + a separate human `forecastCategory`, author required by CHECK), `RenewalOutcome` (append-only trigger, frozen forecast snapshot, one original per renewal, corrections name what they replace), `ExpansionOpportunity` (always an estimate; a number needs a method), `Document` (an AI row names its run). RLS ENABLE + FORCE + `tenant_isolation`, composite FKs, registered. Migration `20261105100000_m7_renewals`. | `tenant-isolation-m7.int.test.ts` (real-field update with own-row control; for the append-only outcome, A→B changes 0 and A's own update is refused by the trigger; composite FKs; CHECKs); `model-registry.int.test.ts` |
| A2 Confidence | `a500ade` | `confidence.ts` (eight factors, signed points, reasons, sources; null factors excluded; clamped; banded by settings), `champion.ts`, `inputs.ts`, `riskSignalsAsOf` in signals, weights as `WorkspaceSettings.renewals`. | `confidence.test.ts` (15), `champion.test.ts` (6); settings suite unchanged |
| A4 Sync | `ee2b94f` | `renewals.sync` as a stage of the nightly score chunk (after health): Renewal rows for ACTIVE contracts renewing in the next year with confidence, reasons and sources; no row and no guess without a renewal date; idempotent; outcomes only from contract records (a later contract within the 31-day grace is RENEWED; an ENDED or CANCELLED contract with no successor is CHURNED) as append-only `RenewalOutcome` rows carrying the forecast as it stood; never opens signals. Pipeline query budget 68 → 71 (three fixed reads; equal at 2 vs 5 accounts; standing pre-approval, `pipeline.int.test.ts`). | `sync.int.test.ts` (6) |
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

## STOP 2: Northgate does not rank lowest (seven-way tie)

The founder accepted the simple model and asked that A5 verify Northgate ranks lowest in the next 90 days before the demo asserts it. On the seed (as of 2026-11-02, `renewals.sync` run by the seed's own nightly pass), open renewals in the next 90 days, sorted by confidence then date:

| Account | Renews | Days | Confidence | Band | ARR |
|---|---|---|---|---|---|
| Aspenwood Fitness | 2026-11-11 | 9 | 70 | HIGH | $201,000 |
| Harborbrook Solicitors | 2026-11-21 | 19 | 70 | HIGH | $88,000 |
| Meridianhaven Consulting | 2026-12-01 | 29 | 70 | HIGH | $3,600 |
| Larkwood Works | 2026-12-11 | 39 | 70 | HIGH | $6,900 |
| **Northgate Freight** | 2026-12-13 | 41 | 70 | HIGH | $142,000 |
| Harborwood Accounting | 2026-12-21 | 49 | 70 | HIGH | $5,700 |
| Beaconcrest Transport | 2027-01-10 | 69 | 70 | HIGH | $12,000 |
| Prairieline Studios … Prairieway Industries (4 more) | 2026-12-31 … 2027-01-30 | 59–89 | 80 | HIGH | |

Why: the shipped model counts two things, the health band and the notice deadline. Every renewal in the window is Healthy (+10), and the seven at 70 are the ones whose notice deadline is within 14 days (or passed) with no renewal plan (−10); the four at 80 have a later deadline. Northgate is one of the seven, not below them, and it is not the largest ARR among them (Aspenwood's is). The only account below 70 in the whole book is Brightwell (40, At Risk), and it renews in 118 days. Nothing was adjusted: no factor, weight or seed row.

## Correction recorded against D-120 (2026-11-05, founder decision)

The founder accepted asserting the tie. M7.md (demo step 2, the confidence test line) and SEED_DATA §5 no longer assert 38% / LOW for Northgate: Northgate is one of seven renewals tied at the lowest confidence (70) in the next 90 days, with its reasons as the data yields them; the LOW-band story arrives with M9/M10 data (promise extraction, call transcripts). The e2e asserts the tie group and Northgate's membership and reasons, nothing stronger.

## Decisions added so far

D-118 (the simple model ships; the rule and the defaults), D-119 (one champion-silence definition; risk signals as of a date), D-120 (the outcome of the model choice, both models' calibration, as accepted by the founder).

## State for the next session

Done: A1–A4. Not done: A5 (forecast, human category with disagreement, `/renewals`, Account 360 panel, the money-redaction helper), A6 (waterfall, billing forecast), A7 (`/revenue`, money at risk, coverage, team load, redaction enumeration test), the mid-milestone full `pnpm test`. `renewals/service.ts` is loaded on use from the pipeline (dynamic import) because the back-test reads the signals module.
