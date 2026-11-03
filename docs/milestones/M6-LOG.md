# M6 — Onboarding & Adoption: Log

**Status:** **COMPLETE.** Session A (A1–A7) and Session B (B1–B4) done; every acceptance item PASS except #15, which is DEFERRED (no provider credentials).
**Baseline:** `aa9f38c` (M5 close), with M5's close numbers taken as recorded from this tree: gate 131 files / 1,267 tests, e2e 49 passed / 0 failed / 35 skipped. No suite was run at baseline.
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
| Usage API (Segment-style intake + Segment destination) | yes (B1) | yes: `ingest-api.int.test.ts` (25), real Redis limiter, real worker job in e2e | **DEFERRED** (no Segment workspace; the HMAC-SHA1 `x-signature` scheme is from Segment's documented Webhooks destination and is untested against Segment itself) |
| Mixpanel | yes (B2) | yes: `contract.test.ts` (8), `mixpanel.int.test.ts` (sync twice: `created 0 / updated 0`, rows identical; another source's day left alone) | **DEFERRED** (no service account) |
| Amplitude | yes (B2) | yes: `contract.test.ts` (7), `amplitude.int.test.ts` (sync twice: no change; account and feature days only, Q-66) | **DEFERRED** (no keys; the segmentation response shape, `seriesMeta` as the group values, is written from the documentation and is the likeliest first live fix) |

Live checks are recorded as DEFERRED, never PASS (M6 rule 7).

### Notes

- `pnpm format:check` (not part of the gate) flags three files that were already unformatted at `aa9f38c`: `src/app/(app)/agent-runs/[id]/page.tsx`, `src/app/(app)/approvals/[id]/page.tsx`, `src/test/db-env.ts`. Left untouched (outside M6 scope); every M6 file passes.
- A7 found and fixed, before commit: the account view loaded only open plans (a completed plan showed no TTV); feature keys showed raw in value definitions; product-event proof is now shown with values and dates and links to Usage (Rule 1).

## Session B (2026-11-04)

### Slices (one commit each)

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| B1 Usage ingest API | `34ed80b` | `POST /api/usage/v1/track \| identify \| batch` on the M5 framework (in `integrations/usage-api/`). Per-integration ingest key stored as SHA-256 + last four, shown once, rotatable, nulled on disconnect (DB CHECK); lookup through a read-only RLS policy that admits the one row whose hash equals the transaction-local hash. Fixed-window Redis rate limit per integration (600/min; 503 if Redis is down, never unthrottled). Segment: `x-signature` HMAC-SHA1 verified with the integration's own sealed shared secret. Raw events exist only in the `usage.aggregate` job payload; `UsageIngestBatch` (hash + counts) is written with the rows, so a replay changes nothing. `NormalizedUsageDay` is a new kind through the one ingest path (`ingest-usage.ts`). Migration `20261104120000_m6_usage_ingest`. | `ingest-api.int.test.ts` (25): wrong key 401 ×4, Bearer and Basic, hash only stored, disconnect, rotation, workspace A's key cannot write B (unmatched in A only), rate limit 429 + Retry-After per key, 503, per-event validation, businessClock and time zone, exact folding, replay (reordered too), ownership, matching, Segment good/bad/other-secret/no-secret, **no raw-event table** (schema + information_schema) |
| B2 Mixpanel + Amplitude + cards | `681293b` | Both adapters write usage days through the same path (SET days), on recorded fixtures; Settings › Integrations gains the Usage API card (generate/rotate key shown once through the form's own result, Segment secret, last batch with unmatched and skipped), Mixpanel and Amplitude forms. | `mixpanel`/`amplitude` `contract.test.ts` (8 + 7), `mixpanel.int.test.ts`, `amplitude.int.test.ts` (sync twice: second run `created 0 / updated 0`, rows identical) |
| B3 Agents + consumers | `5340698` | `onboarding-manager` and `adoption-coach` (prompts 1.0.0 with frontmatter, goldens, citations to real records, numerics overwritten by code, drafts into Approvals, our-side delay never emailed). `onboarding.stalled` / `onboarding.valueReached` consumed: bell notice (two new `NotificationType` values, migration `20261104130000`), a stall asks the Manager; a 15-minute sweep asks the agents for steps due today and open adoption signals. | `onboarding-manager.int.test.ts` (10), `adoption-coach.int.test.ts` (8), `golden-replay-m6.test.ts` (15 cases, 6 adversarial), `consumers.int.test.ts` (10) |
| B4 Demo, e2e, a11y, secrets | `407a5d0` | `pnpm demo:usage`, `e2e/m6-onboarding.spec.ts` (9 steps), `e2e/a11y-m6.spec.ts`, the ingest-key secret rule and a scan over every new fixture, the Adoption Coach's finding on the Adoption tab, Approvals proof links for plans, steps and plan features. | targeted e2e of the two new specs: 9/9 + axe on both viewports |

### Close: the Tier-2 pair (one full e2e, then one full gate, no edits during either)

- **`pnpm test:e2e`** (first and only full run): 51 passed, 1 failed, 8 did not run, 44 skipped. The failure was in **this milestone's test infrastructure**, not the product: `e2e/support/m6.ts`'s reset deleted the Usage API integration before the `ExternalRef` rows the Usage API had learned (foreign key). Batch 1 (cause in this milestone's test code): the helper now deletes those mappings first; **only the failed suite was re-run** (`e2e/m6-onboarding.spec.ts`): 9 passed. Combined: **60 passed, 0 failed, 44 skipped** (the skips are the desktop-only flows on the mobile project, as in M5). One batch used of two.
- **`pnpm gate`** (typecheck + lint + secret scan + test + build): **151 files, 1,456 tests, 0 failed, 217 s; build compiled.** Nothing was edited while either ran.
- **Regression statement.** Against the **M5 close** (gate 131 / 1,267; e2e 49 / 0 / 35): +20 files, +189 tests, 0 pre-M6 test failing; e2e +11 passed (9 in `m6-onboarding.spec.ts`, 2 in `a11y-m6.spec.ts`), +9 skipped (the same 9 on mobile), 0 failed. Against **Session A's mid-run** (141 / 1,364): +10 files, +92 tests, none failing. Every pre-M6 test that ran, passed, with the logged edits below.
- **Fresh-database demo (M6.md §7, with D6/D7).** A brand-new database (0 tables), migrated (61 tables) and seeded, with the e2e app and worker pointed at it (frozen at SEED_TODAY), ran `e2e/m6-onboarding.spec.ts`: **9 passed** (28 s), then it was dropped. It shows, in order: Aisha's Onboarding list with Pinecrest Stalled and its blocker; steps with owners and dates, a step done by a **product event with its proof** (Pinecrest's first dashboard), the **stall raised as a signal**, the handoff with sources and "Not found in CRM"; the bell notice to the owner; the Onboarding Manager's check-in for the IT contact, with reason and proof, edited and approved, sent through dispatch (log transport); the Adoption tab with the Adoption Coach's finding and its sources, its nudge pending; **an Admin's key shown once, `pnpm demo:usage` run twice, the second run changing nothing** (batches 1, same rows) and the Adoption tab moving; a wrong key refused; **a completed account's time to value against its cohort** (Juniper Vet: "Value reached on day 37. Similar accounts (…) reach it by day …"); **a plan created from the matching template**.
- Screenshot (new behaviour): the Usage API card after "Generate key", the key shown once beside "Rotating stops the current key at once", checked in the dev preview as Priya (Admin).

### Acceptance checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | 151 files / 1,456 tests, typecheck, lint, secret scan (828 files), build |
| 2 | `pnpm test:e2e` incl. `m6-onboarding.spec.ts` | **PASS** | 60 passed / 0 failed / 44 skipped (after one test-infrastructure batch, above) |
| 3 | Stall rules have fire + not-fire fixtures | **PASS** | Session A: golden fixtures for the five `onboarding_*` rules (auto-discovered) |
| 4 | TTV math incl. cohort fallback and missing value definition | **PASS** | Session A: `ttv.test.ts` |
| 5 | Handoff items carry sources; missing ones say "Not found in CRM" | **PASS** | `handoff.test.ts` (5); e2e step 2 shows "Not found in CRM" and source links |
| 6 | Usage API rejects wrong-workspace key; no cross-tenant write | **PASS** | `ingest-api.int.test.ts`: A's key + B's account id → unmatched in A only, B has 0 rows and 0 batches; key-lookup policy admits one row; e2e wrong key → 401 |
| 7 | Aggregation idempotent | **PASS** | `ingest-api.int.test.ts` (same batch, reordered, resent: `SKIPPED`, snapshot identical, one ledger row); e2e: `demo:usage` twice, rows equal |
| 8 | Mixpanel + Amplitude contract tests | **PASS** | `mixpanel/__tests__/contract.test.ts` (8), `amplitude/__tests__/contract.test.ts` (7), plus the two `*.int.test.ts` |
| 9 | Manager + Coach drafts go to Approvals; nothing sent | **PASS** | `onboarding-manager.int.test.ts`, `adoption-coach.int.test.ts` (`AWAITING_APPROVAL`, `sentAt` null, `DRAFT_FOR_APPROVAL`); e2e steps 4–5 (Approval pending; sent only after a person edits and approves) |
| 10 | Every SUCCEEDED run records prompt version, model, inputRefs, output, reasoning, confidence | **PASS** | DB CHECK from M4 + the Rule 5 assertion in `onboarding-manager.int.test.ts`; both agents are in the AI team list |
| 11 | No LLM-originated numbers in adoption/TTV display | **PASS** | numbers rule tests in both agent files (invented "40 days" / "4 of 5" → UNCITED; proposed-action numerics overwritten: days 12, count 3); goldens `invented-days`, `invented-count`; `adoption.ts` / `ttv.ts` are code |
| 12 | Tenant suite covers new models | **PASS** | Session A `tenant-isolation-m6.int.test.ts`; B1 adds `UsageIngestBatch` to the registry (RLS + FORCE + policy, `model-registry.int.test.ts`) and the usage key path above |
| 13 | `/onboarding` paginates; no N+1 | **PASS** | Session A `plans.int.test.ts` (same query count at 2 and 5 plans) |
| 14 | axe on /onboarding, Onboarding tab, Adoption tab, templates (desktop + 375 px) | **PASS** | `e2e/a11y-m6.spec.ts` 2/2 (also opens Settings › Integrations with the new cards). It found one real issue (a link inside a `<summary>` on the Onboarding tab's proof); fixed before the full run |
| 15 | Live Mixpanel/Amplitude/Segment verification | **DEFERRED** | no credentials; built and fixture-verified only (table above) |

### Pre-M6 test edits in Session B (standing pre-approval; none behavioural)

| File | Old | New | Reason | Guard underneath |
|---|---|---|---|---|
| `src/modules/agents/__tests__/team.int.test.ts` | keys `["health-analyst","outreach","watcher"]` | adds `"adoption-coach"` and `"onboarding-manager"` | the AI team lists every registered agent; M6 registers two | the list still equals the registry |

`src/modules/onboarding/__tests__/evaluate.int.test.ts` (an M6 file) gained an `afterAll` that marks its own onboarding events processed (Q-68). No other pre-M6 test file changed. `src/lib/jobs/__tests__/outbox.int.test.ts` failed twice mid-session (the global outbox's first 100 due events were crowded out by the onboarding events that now have a consumer); it was **not** edited: the seed now marks its own onboarding events processed (D-115) and the stale `_test` rows were marked processed once (`UPDATE "OutboxEvent" … WHERE type IN ('onboarding.stalled','onboarding.valueReached') AND "processedAt" IS NULL`, 204 rows). The fragility is raised as Q-68.

### What was built (Session B, one paragraph each)

- **Usage ingest API** on the M5 framework: intake, key management, rate limit, Segment verification, a worker job that folds events into the three daily tables and discards them, a ledger that makes replays harmless, a no-raw-event proof.
- **Mixpanel and Amplitude** adapters through the same `NormalizedUsageDay` path; Settings › Integrations gains three cards.
- **Onboarding Manager and Adoption Coach**, their prompts, goldens and consumers; two notification types; the Adoption Coach's finding on the Adoption tab; Approvals proof links for plans, steps and plan features.
- **Demo and quality**: `pnpm demo:usage`, `scripts/recorded-onboarding.ts` (recorded transport for the two agents), two e2e specs, a secret-scan rule for the ingest key shape with a scan over every new fixture.

### Files changed (Session B; `git diff --stat af03183..HEAD`: 96 files)

Schema and migrations: `prisma/schema.prisma`, `20261104120000_m6_usage_ingest`, `20261104130000_m6_onboarding_notifications`. Integrations: `usage-api/*`, `ingest-usage.ts`, `ingest.service.ts`, `normalized.ts`, `adapter.ts`, `connection.ts`, `connections.service.ts`, `credentials.ts`, `status.service.ts`, `sync.jobs.ts`, `adapters/{mixpanel,amplitude,usage-api}/*` with fixtures, `src/lib/rate-limit.ts`, `src/lib/db/inbound.ts`, `tenantModels.ts`. Agents: `definitions/{onboarding-manager,adoption-coach,draft-support}.ts`, `registry.ts`, `narrative.ts`, `golden.ts`, `prompts/{onboarding-manager,adoption-coach}.md` and goldens. Onboarding: `consumers.ts`. Usage: `service.ts` (`loadAdoption`). Approvals: `proof.ts`. Jobs: `outbox.ts`, `src/worker/processors.ts`. Screens: Settings › Integrations (+ `usage-key-panel.tsx`), Adoption, Onboarding tab, Notifications. Tooling: `scripts/{demo-usage,recorded-onboarding,secret-patterns}.ts`, `fixtures/usage/pinecrest.json`, `package.json`, `CLAUDE.md`. Tests: listed per slice above.

### Decisions added

D-109 (Usage API on the framework: key, policy, Segment, rate limit) · D-110 (no raw events; the ledger; counting rules and their stated limits) · D-111 (a provider changes only rows it owns) · D-112 (how a group id finds an account) · D-113 (Mixpanel and Amplitude) · D-114 (agents: numbers from code, our-side delay never emailed) · D-115 (consumers, sweep, the seed's own events).

### Questions added (QUESTIONS.md §B)

Q-65 internal Task not gated by an approval · Q-66 Amplitude writes account and feature days only · Q-67 batch-level dedupe, no retention · Q-68 the global outbox test's fragility. None blocks M7.

### Deferrals (homed)

- Live Mixpanel / Amplitude / Segment checks: **when credentials exist** (acceptance #15). Candidates for the first live fix: Amplitude's response shape, Mixpanel's `time` zone reading, Segment's signature header.
- The New Customer Handoff **play** and the Onboarding Stall **play**: **M8** (this milestone built the assembly, the detection, the consumers and the two agents they will use). Long-tail auto-send of nudges: **M8**.
- Call-derived goals and promises in the handoff: **M9**. Pre-call briefs for kickoff meetings: **M10**.
- People-level rows from Amplitude (Q-66) and per-event dedupe or stored identities (Q-67): Phase 2 warehouse scope.
- One line for the M12 setup guide (Q-33): a customer sending events only through the Usage API is told that raw events are not kept.

### Known risks

- **Customer usage data shape varies.** The Usage API wants a `userId` and a `groupId` that resolves to exactly one account (account id, CRM id or domain); anything else is listed on the card as not matched, not saved. Expect first customers to need a mapping conversation.
- **Mixpanel export limits.** The raw export allows few calls an hour; a FULL read is 13 weekly calls, an INCREMENTAL one is one. A project with very large event volume per week will be slow and may hit the limit; the failure is plain-worded and the next run resumes.
- **Amplitude** segmentation shows at most 1,000 group values per query; features need an event-to-feature mapping the workspace maintains.
- **Fixture shapes are written from provider documentation**, not recorded from live accounts (no credentials); the contract tests prove the adapters against the fixtures only.
- **Sweeps and recorded transport.** The 15-minute agents sweep, like the Health Analyst's, asks the model for work it finds; with `AI_PROVIDER=recorded` and no recording a run is FAILED and visible in the AI team. Nothing is written in its place.

### Note for M7

`loadAdoption` (ctx-only) and the cohort/TTV helpers are ready for renewal confidence; seat utilisation from `adoption.ts` feeds the expansion seat-limit rule; `Goal` exists; the Usage API's `ExternalRef` mappings (source `USAGE_API`) are the way a customer's own account ids map to ours.
