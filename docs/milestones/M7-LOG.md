# M7 — Renewals, Revenue & Expansion: Log

**Status:** **Session A complete (A1–A7 committed).** The one mid-milestone full `pnpm test` ran after A7: **167 files / 1,557 tests, all passed** (exit 0). No gate and no full e2e yet (both are the Session B close). Targeted e2e of the new spec only: `m7-renewals-revenue.spec.ts` 4/4. Session B not started.
**Baseline:** `326a0cf` (M6 close + review fixes): gate 151 files / 1,456 tests, e2e 60 / 0 / 44, as reproduced by the independent review. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed). `NIGHTLY_SCHEDULES`, the fake-clock pin and every pin are untouched. No new dependencies.

## Session A (2026-11-05), slices committed

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| A1 Models | `ccae4d7` | `Renewal` (computed confidence + a separate human `forecastCategory`, author required by CHECK), `RenewalOutcome` (append-only trigger, frozen forecast snapshot, one original per renewal, corrections name what they replace), `ExpansionOpportunity` (always an estimate; a number needs a method), `Document` (an AI row names its run). RLS ENABLE + FORCE + `tenant_isolation`, composite FKs, registered. Migration `20261105100000_m7_renewals`. | `tenant-isolation-m7.int.test.ts` (real-field update with own-row control; for the append-only outcome, A→B changes 0 and A's own update is refused by the trigger; composite FKs; CHECKs); `model-registry.int.test.ts` |
| A2 Confidence | `a500ade` | `confidence.ts` (eight factors, signed points, reasons, sources; null factors excluded; clamped; banded by settings), `champion.ts`, `inputs.ts`, `riskSignalsAsOf` in signals, weights as `WorkspaceSettings.renewals`. | `confidence.test.ts` (15), `champion.test.ts` (6); settings suite unchanged |
| A4 Sync | `ee2b94f` | `renewals.sync` as a stage of the nightly score chunk (after health): Renewal rows for ACTIVE contracts renewing in the next year with confidence, reasons and sources; no row and no guess without a renewal date; idempotent; outcomes only from contract records (a later contract within the 31-day grace is RENEWED; an ENDED or CANCELLED contract with no successor is CHURNED) as append-only `RenewalOutcome` rows carrying the forecast as it stood; never opens signals. Pipeline query budget 68 → 71 (three fixed reads; equal at 2 vs 5 accounts; standing pre-approval, `pipeline.int.test.ts`). | `sync.int.test.ts` (6) |
| A3 Back-test | `f323b7a` | `runRenewalBacktest`: 12 churns + 12 renewals scored as of 90/60/30 days before each outcome from cut bundles; factor vs simple model; calibration by band and score, Brier, AUC; `calibration.ts`; fixture `confidence-backtest-seed.json`. | `calibration.test.ts` (3), `seed-renewals.int.test.ts` (4: fixture exact and repeatable, shipping rule, no look-ahead) |
| A5 Radar | `068454a` | `forecast.ts` (pure: sums by computed band and by human category with the contributing renewal ids; other currencies and no-ARR renewals listed apart; `disagreement`), `setForecastCategory` (the account's owner, a CS Leader or an Admin; audited with before and after; never touches the computed confidence), `listRenewals` (30/60/90/180/365 days, owner, band, page of 25, book scope, lowest confidence first then date, every reason with its sources), `/renewals` (forecast, list, "Why 70%" drill-down, category control, disagreement flag), Account 360 › Renewal tab, shared money-redaction helper `billing/redact.ts` (`redactFinancials` now goes through it), Renewals in the nav (`SHIPPED_MILESTONE` 7, features.test.ts M7 row). | `forecast.test.ts` (3), `seed-renewals-radar.int.test.ts` (4: the seven-way tie with ARR and date, Northgate's membership and reasons, no-revenue member gets no money, category set/audit/clear), `features.test.ts` (33) |
| A6 Waterfall | `b8fa34e` | `waterfall.ts` (opening = events before the period per currency; new/expansion/contraction/churn/reactivation with event ids; closing = opening + movements in BigInt and checked against the sum of every event; sign anomalies shown), `arrMismatches` (events vs the contract in force; no-value contracts skipped), `syncArrChecks` as a stage of the nightly chunk opening `ARR_MISMATCH` items (money-free text; migration `20261105110000_m7_arr_mismatch`), `billingForecast.ts`. | `waterfall.test.ts` (8), `billingForecast.test.ts` (3), `sync.int.test.ts` (2: open, idempotent, resolve, reopen, dismissed stays; other workspace never read), `seed-revenue.int.test.ts` (2: the seed reconciles and closing ARR equals the contracts in force; no mismatches) |
| A7 Revenue | `0b467eb` | `moneyAtRisk.ts` (open renewals in 30/90 days whose account is At Risk or whose confidence is LOW, with reasons), `coverage.ts` (no contact in N days; "no contact recorded" listed apart), `teamLoad.ts`, `getRevenueView`, `/revenue` (needs `revenue:view`, a 404 otherwise; Revenue in the nav only with it), `e2e/m7-renewals-revenue.spec.ts`. | `views.test.ts` (4), `seed-redaction-m7.int.test.ts` (5: every M7 read model without revenue access has no money key and no contract figure; `/revenue` refuses; query budgets fixed: `listRenewals` equal at 30 vs 365 days and ≤ 8, `getRevenueView` ≤ 10), e2e 4/4 |

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

## Seed facts the screens rely on (as of 2026-11-02)

- `/renewals` 90-day window, lowest first: the seven-way tie at 70 (table above), then four at 80. No renewal below 70 renews inside 90 days.
- Revenue waterfall, 2026-08-01 to 2026-11-02 (USD): opening $1,930,500; new $229,000; churn −$211,000; closing **$1,948,500**, equal to the sum of the contracts in force; reconciled; **no ARR mismatches** in the seed.

## Deviations and pre-M7 edits (all logged)

| What | Why |
|---|---|
| `src/modules/signals/__tests__/pipeline.int.test.ts` query budget, **68 → 71 (A4) → 74 (A6)** | Fixed reads added to the nightly chunk: three for `renewals.sync` (contracts, renewal rows, settings) and three for the ARR cross-check (revenue events, contracts, open mismatch items). Equal at 2 vs 5 accounts still holds. Standing pre-approval (count/budget constants only); no logic changed. |
| `src/modules/accounts/data-quality-service.ts`: the manual scan excludes `ARR_MISMATCH` as it already excludes `CONFLICT` | Otherwise the scan would resolve items the nightly stage owns. Data-quality tests unchanged and passing. |
| `src/app/(app)/settings/data-quality/page.tsx`: label for the new kind | Type-exhaustive map. |
| `src/modules/billing/service.ts`: re-exports `currentContract`, `deriveRevenueEvents`, `ContractFacts`, `canSeeMoney`, `redactMoney` | Module boundary: revenue reaches billing through its service. |
| M7 seed-using tests live in `prisma/seed/__tests__/` (radar, revenue, redaction) rather than beside the modules | `vitest.config.ts` runs seed-dependent files serially in the demo-seed project; the config is untouched. The redaction enumeration is therefore `seed-redaction-m7.int.test.ts`, not `revenue/__tests__/redaction.int.test.ts`. |
| The forecast "disagreement" compares the human category with the band's suggestion (HIGH→Commit, MEDIUM→Best case, LOW→At risk); Omitted is never a disagreement | Plain, deterministic; shown beside both values. |
| Money at risk counts renewals in the window (not every At Risk account) | Each item is a renewal with an id and a date; stated on the page. |

No pre-M7 test other than the budget constant was edited. No gate was run yet (Session B close).

## Decisions added so far

D-118 (the simple model ships; the rule and the defaults), D-119 (one champion-silence definition; risk signals as of a date), D-120 (the outcome of the model choice, both models' calibration, as accepted by the founder), D-121 (one money-redaction helper, `/revenue` all-or-nothing, the ARR cross-check as a nightly stage).

## State for Session B

**Done and committed:** A1–A7 (list above). Tree clean at `0b467eb` plus the docs commit that carries this log. Dev and `_test` databases are migrated through `20261105110000`.

**Session B, as planned (not started):**

- **B1 Expansion rules and estimate.** Extend `seats_near_limit` for credits (D5: stop and report if it changes any pre-M7 rule behaviour or fixture); `SEATS_OVER_LIMIT` priced only from the account's own subscription/contract, `TIER_UPGRADE_DELTA` "No price on file" (D6); `GOAL_STATED_EXPANSION` only on Goal rows with `metricKey` explicitly seats/users, dormant until M9 otherwise, and say in the log whether any seeded goal qualifies (D7); new-team / fast-growth burst rule, ≥ 8 first-seen people within 21 days after a stable 60 days, audited settings (D8). Fixtures and audited thresholds for each; `estimate.ts` (a labelled estimate with its method, never a promised number).
- **B2 Expansion service and screen.** `ExpansionOpportunity` service, `/expansion`, Expansion in the nav, whitespace panel with no money figure, CRM export through the write-back gate (D-116).
- **B3 Documents and agents.** `Document` with locked metrics and a placeholder validator; the renewal-manager and expansion-finder agents (prompts with frontmatter, goldens, drafts to Approvals, `AgentRun` for everything).
- **B4 Outcome checkpoints.** Revenue statuses added to the existing outcome checkpoint (30/90-day outcomes stay M11).
- **B5 Seed and demo check.** Copperleaf: 12 seats at $900 derivable from its own records (stop and report if not); Northgate demo steps as the corrected M7.md describes (the tie, not LOW).
- **B6 Close.** a11y-m7 spec, extend `m7-renewals-revenue.spec.ts` (expansion, brief, outcomes), then exactly one e2e (first) and one `pnpm gate`, milestone acceptance checklist with PASS/FAIL, CHANGELOG, plan checkbox. Live billing checks stay DEFERRED; Docker #16 stays PARTIAL.

**Things Session B should know:** `renewals/service.ts` is loaded on use from the pipeline (dynamic import) because the back-test reads the signals module; `syncArrChecks` is imported statically (revenue has no cycle). The shipped model counts only health band and notice deadline, so the radar's confidence has two moving parts until M9 data arrives; the forecast category is the human's call and is shown beside it. `prettier --write` on the whole of `src` also rewrites three untouched files (`agent-runs/[id]/page.tsx`, `approvals/[id]/page.tsx`, `src/test/db-env.ts`): format only the files you changed.
