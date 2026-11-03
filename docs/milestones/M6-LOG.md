# M6 — Onboarding & Adoption: Log

**Status:** Session A COMPLETE (A1–A7); Session B not started.
**Baseline:** `aa9f38c` (M5 close), with M5's close numbers taken as recorded from this tree: gate 131 files / 1,267 tests. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed; no docker command run). `NIGHTLY_SCHEDULES` and the fake-clock pin are untouched. Pins stay pinned. No new dependencies.

## Slice 0 — Q-56 (2026-11-03)

`7dfe001`: the Slack card reads "Connected · messages your team"; its connect notice says what it sends and that it never messages customers; the page intro no longer calls every connection read-only. One M5 e2e assertion changed with it (`e2e/m5-integrations.spec.ts:193`, the Slack status text): **ratified by the founder** before Session A.

## Session A (2026-11-03 → 2026-11-04)

### Slices (one commit each)

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| A1 Models | `3a6110c` | `OnboardingTemplate`, `OnboardingPlan`, `OnboardingStep`, `Goal` with composite FKs and RLS (ENABLE + FORCE + `tenant_isolation`), registered in `TENANT_MODELS`. DB CHECKs: a done step says how; a HUMAN step names the member; a PRODUCT_EVENT step carries evidence; one owner per step; value reached carries evidence; an AI goal names its run. Partial unique index: one open plan per account. `IntegrationProvider`/`RecordSource` gain `USAGE_API`, `MIXPANEL`, `AMPLITUDE`. Contact merge repoints step owners (composite FK is NO ACTION, D-108). Migration `20261103181329_m6_onboarding`. | `tenant-isolation-m6.int.test.ts` (10: real-field update attacks with own-row controls), `model-registry.int.test.ts` |
| A2 TTV + stall | `ab41121` | `chooseCohort` extracted from the M3 `cohortBaseline` (behaviour unchanged) and reused for time to value (M6 rule 3). `ttv.ts` (D3) and `stall.ts` (D2, D4), deterministic, every blocker with sources. | `ttv.test.ts`, `stall.test.ts`; the 152 M3 health tests unchanged and passing |
| A3 Rules | `ae4aaa1` | Five catalogue rules: `onboarding_stall`, `onboarding_step_overdue_customer`, `onboarding_no_activity`, `onboarding_key_feature_unused`, `onboarding_ttv_late` (category USAGE, the four spec fields, audited thresholds), with golden fixtures. A stall opens a signal and sends nothing. | golden fixtures (auto-discovered), `rule-settings.int.test.ts` |
| A4 Nightly pass | `63a22fe` | `evaluateOnboarding` in the signals chunk: product-event step completion with the proving row ids (D1), value reached (status COMPLETE + proof), stall status and blockers; outbox `onboarding.stalled` / `onboarding.valueReached` (awaiting consumers, Session B). Value conditions count weekdays in a row (D-104). Nothing writes health (M6 rule 5). | `value.test.ts` (8), `evaluate.int.test.ts` (real queue), static check that the onboarding module never touches `healthScoreSnapshot` |
| A5 Adoption | `77cca84` | `adoption.ts`: seats, credits, never-used plan features, power-user retention, trend vs own normal and cohort, missing notes. A **new Adoption tab beside Usage** (D6). | `adoption.test.ts` (6), `adoption.int.test.ts` |
| A6 Handoff | `9ca6417` | `assembleHandoff`: contract terms, key people, stated goals, open risks, kickoff notes, each with sources; a missing item says "Not found in CRM"; money only with revenue access. No text extraction (M9). | `handoff.test.ts` (5) |
| A7 Plans + screens + seed | `1e9a2f6` | Templates (create/edit/archive, `plays:publish`, audited), plan creation from the matching template, step done by a person / blocked / re-dated / added / removed. `/onboarding` list, Account 360 › Onboarding (steps, product-event proof, TTV with cohort, handoff with sources), Settings › Onboarding templates, nav row (`SHIPPED_MILESTONE = 6`). Seed: templates, the 8 §7 plans, goals, seed-only completed history for cohort TTV. | `plans.int.test.ts` (5, including same query count for 2 and 5 plans), `seed-onboarding.int.test.ts` (6), `features.test.ts`; screens checked in the dev preview as Aisha and Admin |

### Mid-milestone full run (the one allowed)

`pnpm test` at `1e9a2f6`: **141 files passed, 1,364 tests passed, 0 failed, 220.2 s.** Against the M5 close (131 / 1,267) that is +10 files and +97 tests, with no pre-M6 test failing. No file was edited while it ran. (The FAILED agent-run log lines in the output come from tests that assert those failures.)

### Founder decisions applied (D1–D7)

- **D1** step completion: a person, or a verified product event with the proving row ids. Audited; never a timer (D-100).
- **D2** blocker order: our overdue steps → customer's → no logins → key feature unused → TTV past P75 (D-101).
- **D3** TTV definition: days from plan start to the first day the template's value definition held, against the cohort of completed plans (D-102).
- **D4** one stall definition in `stall.ts`, shared by the rules and the nightly pass (D-101).
- **D5** usage ingestion: rides the M5 framework (Session B).
- **D6** Adoption is a **new tab beside Usage**. *This supersedes M6.md §2 ("Account 360 › Adoption tab (replaces the raw Usage tab framing)")*: the Usage tab stays as it was.
- **D7** the demo signs in as **Aisha Bello**. *Correction to M6.md §7 step 1 ("Sign in as Leo Marsh")*: Pinecrest, Ostara and the other stalled demo accounts are in Aisha's book; Leo owns Cobalt Ridge and Lumen.

### Approved pre-M6 test edits

| File | Old | New | Reason | Approval |
|---|---|---|---|---|
| `e2e/m5-integrations.spec.ts:193` | "Connected · read-only" | "Connected · messages your team" | Q-56 copy fix (slice 0) | founder ratified |
| `src/modules/signals/__tests__/rule-settings.int.test.ts:36` | `toHaveLength(15)` | `toHaveLength(20)` | catalogue growth: the five M6 onboarding rules | founder, explicit |
| `src/modules/signals/__tests__/pipeline.int.test.ts:208` | 67 | 68 (comment names "(M6) one read for open onboarding plans") | one fixed per-chunk read; still equal at 2 vs 5 accounts | founder, explicit |
| `src/config/__tests__/features.test.ts` | — | M6 row only | nav milestone row (M6 rule 8) | milestone rule |

The **standing pre-approval** (count and budget constants, logged here) was **not used** in A5–A7: no other pre-M6 test changed.

### Seed additions (seed-only; SEED_DATA §7 "As seeded")

Three templates; the eight §7 plans with steps (story steps left open, others done by the owner, product-condition steps left to the nightly pass); goals for Saltmarsh (2) and Pinecrest (1); completed plans started 300 days ago on adopted accounts, for cohort TTV. Every status, stall reason and value day comes from the seed's own nightly pass. Resulting states match §7 for all eight, with one deviation: **Juniper Vet reaches value on day 37, not 38** (Q-58).

### Questions raised (QUESTIONS.md §B)

Q-58 Juniper day 37 · Q-59 Pinecrest "by day 21" · Q-60 "3 of 5 features" · Q-61 Lumen's target · Q-62 rule key casing · Q-63 evaluation order · Q-64 the promised integration (M9). None blocks Session B.

### Per-provider status (usage adapters)

| Provider | Built | Fixture-verified | Live |
|---|---|---|---|
| Usage API (Segment-style) | Session B | — | — |
| Mixpanel | Session B | — | — |
| Amplitude | Session B | — | — |

Only the enum values and display names exist (A1). Live checks will be **DEFERRED** without credentials (M6 rule 7).

### Notes

- `pnpm format:check` (not part of the gate) flags three files that were already unformatted at `aa9f38c`: `src/app/(app)/agent-runs/[id]/page.tsx`, `src/app/(app)/approvals/[id]/page.tsx`, `src/test/db-env.ts`. Left untouched (outside M6 scope); every M6 file passes.
- A7 found and fixed, before commit: the account view loaded only open plans (a completed plan showed no TTV); feature keys showed raw in value definitions; product-event proof is now shown with values and dates and links to Usage (Rule 1).
