# M5 — Integrations Core: Log

**Date:** 2026-11-03 · **Result:** **COMPLETE: 15 of 16 acceptance checks PASS, #16 (live sandboxes) DEFERRED** (no sandbox credentials; never PASS). Tier-2 pair: **e2e 48 passed / 1 failed / 35 skipped → failure batch 1 (Setup tab order, this session's code) → that suite 2 passed → gate 131 files / 1,267 tests, lint + secret scan clean, build OK** at `6998b08`. The fresh-database demo then found a Today-refresh gap (acceptance #6); **failure batch 2** fixed it in `e1b1490` (+4 lines), and the M5 e2e suite (7/7) plus the affected unit/integration suites (52 tests), typecheck and lint were re-run green. The full gate was not re-run after batch 2, per the batching rule.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed; no docker command run).
**Live services:** none called anywhere in M5. All five connectors are fixture-verified; live checks are **DEFERRED** (no sandbox credentials). Live write-back is DEFERRED by founder D2 regardless.

**Baseline:** `a4ed077` (M4 docs commit), with M4's close numbers taken as recorded from this tree: gate 110 files / 1,078 tests; e2e 40 passed / 28 skipped. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed). No docker command was run.

## Session A (2026-11-03)

### Slices (one commit each)

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| A1 Models | `8c8adb9` | `Integration`, `SyncJob`, `WebhookEvent`, `SlackUserLink` with composite FKs and RLS (ENABLE + FORCE + `tenant_isolation`); two read-only inbound lookup policies (webhook integration id, Slack team id); DB CHECKs: a disconnected integration holds no credentials, and write-back fields need the switch. `Account/Contact.fieldSources` (D1), `DataQualityKind.CONFLICT`, `RecordSource` HUBSPOT/SALESFORCE/STRIPE/CHARGEBEE, `Notification.channel`. Migration `20261103103546_m5_integrations`. The data-quality scan no longer resolves CONFLICT issues it did not raise. | `tenant-isolation-m5.int.test.ts`, `model-registry.int.test.ts` (115 tests at that point) |
| A2 Framework core | `95664d9` | `adapter.ts` (ARCH §8.1), `normalized.ts`, `transport.ts` (live/fixture, `requestJson`), `fixture-transport.ts` (refuses unfixtured requests), `credentials.ts` (sealed), `errors.ts` (plain words), env names, logger redaction, `INTEGRATIONS_TRANSPORT=fixture` refused in production. | `framework.test.ts` (17) |
| A3 Ingest | `11748fb` | `ingest.service.ts`: the one upsert path through ExternalRef. It covers owners by email (unknown owners listed), accounts, contacts, billing customers (matched, never created), subscriptions, invoices and contracts (ARR via `recomputeCommercials`). Q-32/D1 provenance (`provenance.ts`). Each batch runs in a tenant transaction behind an advisory lock. | `ingest.int.test.ts` (12, including the 500-record query budget ≤ 12 queries for create and for re-sync) |
| A4 Sync engine | `6515d28` | `sync.run`: cursor, `SyncJob` counts, `errorPlain`, 401/403 → ERROR, unfixtured rethrown. `nightly.kickoff` becomes a flow parent only when data integrations exist. Run sync now. Token refresh in `loadConnection`. `sync.completed` outbox event (awaiting a consumer). | `sync.int.test.ts` (7, including the real-queue flow); pre-M5 pipeline/worker/job tests **unchanged**, 28 pass |
| A5 OAuth | `4a14911` | Signed state with a nonce cookie, exchange, sealed tokens, refresh, connect/disconnect/test, API-key connect; connect and callback routes. | `oauth.test.ts` (16) |
| A6 Webhooks | `43aa092` | Route, uniform 401, raw payload stored, deduped `WebhookEvent`, `webhook.process` with in-job signal evaluation. | `webhook.int.test.ts` (5) |
| A7 Write-back | `97c89a0` | Gate, `WRITE_BACK` approval, re-check on approve, single push, audit on every path, Admin-only switch. | `writeback.test.ts` (6); approvals suites unchanged and passing |
| A8 Stripe | `f3582ae` | Adapter, fixtures, `Stripe-Signature` verify. | `stripe/contract.test.ts` (17), `stripe/stripe.int.test.ts` (2) |
| A9 HubSpot | `583cb3e` | Adapter, fixtures, owner write-back. Also: a Slack team connected to two workspaces now resolves to neither. | `hubspot/contract.test.ts` (12), `hubspot/hubspot.int.test.ts` (2) |
| A10 Settings › Integrations | `43b8861` | Admin tab with status, last run and counts, unusable records in plain words, last error, Connect / Test / Run sync now / Disconnect, Stripe webhook address, write-back picker. `SHIPPED_MILESTONE = 5`; `features.test.ts` gains only the M5 row. | `features.test.ts`; cross-tenant action-service test in `tenant-isolation-m5`; fixture-mode preview (below) |

### Mid-milestone full run (the one allowed)

`pnpm test` at `43b8861`: **121 files passed, 1,202 tests passed, 0 failed, 203.6 s.** Against the M4 baseline (110 / 1,078) that is +11 files and +124 tests, with no pre-M5 test failing. No file was edited while it ran.

### Per-connector status

| Connector | Built | Fixture-verified | Live |
|---|---|---|---|
| HubSpot | Session A | contract (pagination, archived, invalid, incremental search, OAuth exchange/refresh, 401/403/429/500), sync twice, owner mapping, Q-32 conflict, owner write-back via gate (fake transport) | **DEFERRED** (no sandbox credentials). Live write-back DEFERRED by founder D2 even if credentials appear. |
| Stripe | Session A | contract (pagination, deleted/unmatched customers, rejected interval, draft skipped, 401/403/429/500), forged/stale signatures, sync twice, payment_failed → signal in the same job | **DEFERRED** (no test-mode key) |
| Salesforce | Session B | — | — |
| Chargebee | Session B | — | — |
| Slack | Session B (inbound team lookup and `SlackUserLink` model ready) | — | — |

### Preview check (new behaviour, fixture mode)

The preview ran on its own database, `nexaworks_m5preview` (created and granted like `m4demo`, 18 migrations, seed 9 s), with `INTEGRATIONS_TRANSPORT=fixture`, its own queue prefix, the worker running and `NIGHTLY_SCHEDULES=off`. Steps, signed in as Priya (Admin):

1. **Connect HubSpot:** signed state, nonce cookie and fixture code exchange gave "Connected · read-only".
2. **Run sync now** (worker): "4 added, 1 updated, 2 unchanged, 4 conflicting values left for you (Data quality), 3 not matched, 2 skipped as invalid".
3. **Data quality** shows the conflicts, e.g. *HubSpot says the name is "Brightwell Logistics Inc.", but here it is "Brightwell Logistics" (set by the demo data). Nothing was changed.*
4. **Re-sync** (after making the incremental fixture an unchanged record): "0 added, 0 updated, 3 unchanged, 2 not matched".
5. **Connect Stripe** with a fake key, then sync: "7 added, 0 updated, 0 unchanged, 2 not matched, 1 skipped as invalid", plus the webhook address.

Server log had no errors. Evidence: `m5-evidence/01-settings-integrations-hubspot-stripe-synced.jpg`.

### Decisions and questions

- **Decisions:** D-82 … D-93 (no SDKs; Q-32 provenance; billing match-only; fixture transport; new-account tier; Stripe window and failure dates; HubSpot deals; write-back gate; webhooks; nightly flow and ids; OAuth state; Slack team ambiguity).
- **Questions:**
  - Q-50: the action-enumeration test does not exist yet (M12); M5 covers the integrations actions explicitly.
  - Q-51: `update-attack.ts` gained four entries (ratified by the founder at the start of Session B).
  - Q-52: Sundial can show more than one payment signal in the fixture world.
  - Q-53: `next dev` request log shows the OAuth callback URL.

### Deviations reported (none loosen a check)

- **M5.md §4 "each slice ends with `pnpm gate`"** is superseded by the founder's execution economics: targeted tests per slice, and one full `pnpm test` at the end of Session A.
- **M5.md names `oauth.test.ts` / `writeback.test.ts`:** both use the database, kept under those names.
- **Pre-M5 test files touched:** the four approved, plus `update-attack.ts` (Q-51, ratified).
  - `features.test.ts`: only the M5 row.
  - `tenant-isolation`: new M5 file.
  - `model-registry`: no change needed; it picks the models up from the registry.
  - `playwright.config.ts`: not yet touched (Session B).
- **Pre-M5 product files extended:**
  - `approvals/lifecycle.ts`: optional `writeBack` payload, and the approved write-back runs through the gate.
  - `accounts/data-quality-service.ts`: CONFLICT excluded from scan resolution.
  - `signals/pipeline.ts`: optional `afterSync` and the flow branch.
  - `settings/access.ts` (tab) and `data-quality/page.tsx` (label).
  - `lib`: `env`, `logger`, `locks`, `queues`, `outbox`, `tenantModels`.
  - `worker/processors.ts`.
- **Real gaps found and fixed in-session:**
  - A missing adapter could have thrown after an approval was recorded (now REFUSED and audited).
  - A Slack team id present in two workspaces would have resolved to one at random (now neither).
  - Two tests used fixed global emails or team ids, which collide on a re-run against the same test DB (now unique per run).

### Known risks so far

- **Rate limits:** a 429 is recorded in plain words and the next run resumes; there is no in-run backoff yet.
- **Stripe sync reads full lists:** fine at B2B volumes; revisit if a customer has very many invoices.
- **HubSpot incremental runs** depend on `hs_lastmodifieddate`. Deletions between full runs are not seen until the next FULL. Every run is INCREMENTAL once a cursor exists, so a periodic FULL is a Session B question.
- **Sync counts and problems live in `SyncJob.counts` JSON**, capped at 50 problems per run.

### Session B starts from here

Session B covers Salesforce (OAuth, `nextRecordsUrl`, Opportunity → Contract, owner write-back), Chargebee (API key + site, Basic-auth webhook with forged-credentials test), Slack (bot OAuth, notifications + digest as a step after `today.rebuild`, interactivity with signature + 5-minute window + mapping + `approvals:decide` + book scope, Q-31 refusal test), Settings › Data health, `/setup` wizard, `db:seed --empty-workspace`, `pnpm demo:webhook`, `playwright.config.ts` (`INTEGRATIONS_TRANSPORT=fixture` only), `e2e/m5-integrations.spec.ts` + `a11y-m5.spec.ts`, secret-scan check, then the Tier-2 pair (one e2e, then one gate), CHANGELOG, plan checkbox and the fresh-database demo.

## Session B (2026-11-03)

Q-51 (`update-attack.ts` entries) was **ratified** by the founder at the start of Session B.

### Slices (one commit each)

| Slice | Commit | What | Targeted evidence |
|---|---|---|---|
| B1 Salesforce | `85a33ac` | OAuth with instance URL; `queryAll` + `nextRecordsUrl`; deleted rows keep mappings; users by email; won opportunities → contracts when turned on; owner write-back behind the gate (204 accepted). Framework: fixture header and contains matching; a 401 from an OAuth provider mid-sync refreshes once and re-reads (D-94). Shared CRM helpers. | `salesforce/contract.test.ts`, `salesforce.int.test.ts` (13): sync twice, conflict naming HubSpot as primary, expired session refreshed and re-sealed, owner write-back |
| B2 Chargebee | `e4c55eb` | Site + key; `next_offset`; `updated_at[after]`; dunning-dated failures; Basic-auth webhooks with constant-time check (D3, D-98). | `chargebee/contract.test.ts`, `chargebee.int.test.ts` (17): forged credentials refused (401, nothing stored), real event opens the signal in the job, sync twice |
| B3 Slack | `a35d008` | Bot OAuth; links by verified email; approvals (outbox `approval.requested` → `outbound`), real-time signals and a morning digest as DMs; once-only delivery rows (partial unique index); bell shows in-app only; interactivity with signing secret + 5-minute window, ambiguous team → nothing, decisions via the M4 lifecycle with `via: "SLACK"`; sensitive refused at three layers, flag `SENSITIVE_DECISIONS_FROM_SLACK = false` (D-95). Migration `m5_slack`. | `slack/contract.test.ts`, `interactivity.int.test.ts`, `slack.int.test.ts` (24): bad signature/stale/no secret → 401; unmapped, Viewer, out-of-book refused; in-book CSM approves (decidedById, SLACK, audit); reject with note; **sensitive attempt REFUSED, flag off, lifecycle and DB CHECK refuse too**; **ambiguous team resolves to neither**; another workspace's approval not decidable |
| B4 Data health | `e3d6949` | Dead jobs (own workspace only), failed syncs and webhooks, plain words; Run again (audited) (D-97). | `data-health.int.test.ts` on a real queue |
| B5 Setup wizard | `c67616d` | `/setup` five steps; `Workspace.setupPending` (migration `m5_setup`); tier bands saved and re-tiered; default segments; engine back-test sentence; keep-default when history is thin (D-96); Go live compare-and-set, reverted if unaudited (review pass); `db:seed -- --empty-workspace`; `pnpm demo:webhook`. **Found and fixed Q-54** (tier bands read through the transaction). | `setup.int.test.ts` (4), pre-M5 accounts/billing/imports suites unchanged and green (88), `nightly-schedules.int` unchanged and green |
| B6 e2e, a11y, secrets | `6c57cec` | `e2e/m5-integrations.spec.ts`, `e2e/a11y-m5.spec.ts`, `e2e/support/m5.ts` (fresh workspaces per run); `playwright.config.ts` gains only `INTEGRATIONS_TRANSPORT=fixture` (D5); secret scan covers Stripe webhook secrets, HubSpot private-app tokens, Salesforce sessions (`secret-patterns-m5.test.ts`). | targeted e2e of the two specs before the close |
| Batch 1 | `6998b08` | Setup tab moved last: `/settings` opens the first allowed tab, which must stay Users. | `m1-foundation.spec.ts` re-run: 2 passed |
| Batch 2 | `e1b1490` | A real-time signal rebuilds Today at once (D-99, Q-57). | `stripe.int.test.ts` fails without the fix; M5 e2e 7/7 |

### Close (Tier 2, exactly once)

1. **Cleanup of the e2e world** (as established, D-80): the `nexaworks-e2e:*` Redis keys cleared (181 → 0); `_test` is re-seeded by global setup, never reset (D-36); the M5 specs create their own fresh workspaces, so nothing of Larkspur's is touched.
2. **Full `pnpm test:e2e`:** **48 passed, 1 failed, 35 skipped** (2.3 min). The failure: `m1-foundation` landed on `/setup` instead of Users because B5 had put the Setup tab first. Cause in this session's code → **batch 1** fix, re-run of that suite only: **2 passed, 2 skipped**. Net: **49 passed / 0 failed / 35 skipped**.
3. **Full `pnpm gate`:** typecheck clean, lint clean, secret scan "no secrets found", **131 files / 1,267 tests passed**, build OK (Compiled successfully; 28 static pages). At `6998b08`. No edits during either run.
4. **Batch 2** after the demo (below): `e1b1490`, then the M5 e2e suite **7 passed** (desktop; 7 mobile skipped by design) and the Stripe, Chargebee, webhook and Today suites **52 passed**, typecheck and lint clean. Full gate and build not re-run after batch 2.

### Regression statement

- **Against the M4 baseline** (gate 110 / 1,078; e2e 40 / 28 skipped): gate **131 / 1,267** (+21 files, +189 tests), e2e **49 / 35 skipped** (+9 passed: the M5 flow's 7 desktop steps and `a11y-m5` at two widths; +7 skipped: the M5 flow on mobile, desktop-only by design). **No pre-M5 test failed** except `m1-foundation` in the first e2e, caused by this milestone's tab order and fixed without editing the test.
- **Against Session A's mid-run** (121 / 1,202): +10 files, +65 tests, all green.
- Pre-M5 test files changed in M5: `features.test.ts` (M5 row only), `update-attack.ts` (four entries, ratified), `playwright.config.ts` (`INTEGRATIONS_TRANSPORT` only). No assertion was loosened anywhere.

### Fresh-database demo (scratch DB `nexaworks_m5demo`)

Created and granted, 20 migrations deployed from empty, seeded with `--with-test-tenant --empty-workspace` (9 s). App + worker in fixture mode, `SLACK_DELIVERY=log`, demo-only webhook and signing secrets, queue prefix `nexaworks-m5demo`.

1. **Connect each provider** as Priya: HubSpot, Salesforce and Slack through the fixture sign-in; Stripe with a fake key and webhook secret; Chargebee first with the fixture's rejected key → *"The API key was rejected by Chargebee. Paste a new read-only key."*, then a valid one. Slack: 2 members linked by verified email (Aisha, Leo).
2. **Sync twice:** first runs: HubSpot "4 added, 1 updated, 2 unchanged, 4 conflicting values left for you, 3 not matched, 2 skipped as invalid"; Salesforce "3 added, 3 unchanged, 2 conflicting, 3 not matched"; Stripe "7 added, 2 not matched, 1 skipped as invalid"; Chargebee "6 added, 1 not matched". **Second runs: all four "0 added, 0 updated"** (`m5-evidence/05-…`).
3. **Q-32 conflict as a DataQualityIssue:** *"HubSpot says the name is "Brightwell Logistics Inc.", but here it is "Brightwell Logistics" (set by the demo data). Nothing was changed."* (`m5-evidence/06-…`). HubSpot also filled Sundial's empty owner with Aisha (fill-empty rule).
4. **Forged webhook refused:** `pnpm demo:webhook stripe payment_failed sundial --forged` → **HTTP 401 unverified; WebhookEvent rows 0 before and 0 after**. The real one → **202 accepted**, replay → **200 duplicate**, 1 row; Sundial's new "Payment failed" signal opened. *Finding:* Aisha's Today did not show it yet (10-minute cache) → batch 2 (D-99).
5. **Slack:** two approvals in Aisha's book through `requestApproval`; both DM'd to U0AISHA (`.dev-slack/`): the everyday one with Approve/Reject, the cancellation one with only "Open in app to review". Signed clicks from Aisha: **non-sensitive → "Approved." (APPROVED, via SLACK, by aisha@larkspur.test)**; **sensitive → "This one is sensitive, so it is decided in the app only. Open in app to review: …" (still PENDING; one `approval.slack_refused` audit row)**.

### Acceptance checklist (docs/milestones/M5.md §6)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm gate` green | **PASS** | 131 files / 1,267 tests, lint + secret scan clean, build OK (`6998b08`); batch 2 re-ran its suites green |
| 2 | `pnpm test:e2e` incl. `m5-integrations.spec.ts` green | **PASS** | 48/1/35 → batch 1 → net 49/0/35; M5 spec 7/7 again after batch 2 |
| 3 | Adapter contract tests: HubSpot, Salesforce, Stripe, Chargebee, Slack | **PASS** | `adapters/<provider>/__tests__/contract.test.ts` ×5 (pagination, deleted/archived, malformed, 401/403/429/5xx in plain words, OAuth/signatures) |
| 4 | Re-sync idempotent | **PASS** | `ingest.int` (sync twice, 500-record), `sync.int` (same run key no-op), sync-twice in each `<provider>.int`; demo step 2 |
| 5 | Webhook replay deduped; invalid signature rejected | **PASS** | `webhook.int` (401 stores nothing, replay no-op, A's URL + B's signature fails), Stripe/Chargebee forged tests, demo step 4 |
| 6 | Payment-failed opens a signal in real time and the account appears in Today | **PASS** (after batch 2) | `stripe.int` (signal in the same job; owner's Today lists it), `chargebee.int`, e2e Stripe step (Today viewed first) |
| 7 | Write-back refused when disabled / field not allowed; audited | **PASS** | `writeback.test` (6), HubSpot/Salesforce owner push on the fake transport only, e2e write-back step |
| 8 | Slack approve needs signature + mapped user + permission + book | **PASS** | `interactivity.int.test` (8), demo step 5 |
| 9 | Sync errors in plain words on Settings › Integrations | **PASS** | e2e Chargebee step + `m5-evidence/02-…`; `describeError` contract cases; `sync.int` 401/503 |
| 10 | Credentials encrypted at rest; never logged | **PASS** | `oauth.test` (raw column ≠ token, refresh re-seals), `framework.test` (logger redaction), `salesforce.int` (refreshed token sealed), secret scan clean + `secret-patterns-m5.test` |
| 11 | Tenant suite covers Integration, SyncJob, WebhookEvent | **PASS** | `tenant-isolation-m5.int.test` (16: read/real-field update with own-row control/delete/raw SQL ×4 models incl. SlackUserLink, composite FKs, inbound lookups, ambiguous Slack team, every Settings action's service); plus cross-tenant ingest, webhook, Slack and Data health tests |
| 12 | Setup wizard 1–5 on a fresh workspace, CSV-only | **PASS** | e2e setup step (fresh workspace, CSV import → Go live), `setup.int` |
| 13 | Wizard shows the back-test sentence from the deterministic engine | **PASS** | e2e ("With this model, we would have flagged …"), `setup.int` (proposal sentence = M3 `sentence()`) |
| 14 | No N+1 in ingest (500-record query budget) | **PASS** | `ingest.int` › query budget: ≤ 12 queries for 500 creates and for a 500 re-sync |
| 15 | axe on Integrations, Data health, /setup (desktop + 375 px) | **PASS** | `a11y-m5.spec` on both projects |
| 16 | Live sandbox verification | **DEFERRED** | no sandbox credentials in env; nothing live was called. Live write-back DEFERRED by D2 |

### Per-connector status (final)

| Connector | Built | Fixture-verified | Live |
|---|---|---|---|
| HubSpot | yes | yes (contract, sync twice, owners, Q-32, write-back on fake transport, e2e, demo) | **DEFERRED** |
| Salesforce | yes | yes (contract, sync twice, Q-32 with primacy, expired session, write-back on fake transport, demo) | **DEFERRED** |
| Stripe | yes | yes (contract, signatures, sync twice, real-time signal + Today, e2e, demo) | **DEFERRED** |
| Chargebee | yes | yes (contract, Basic-auth webhooks, sync twice, rejected key, e2e, demo) | **DEFERRED** |
| Slack | yes | yes (contract, signing, interactivity incl. Q-31 refusal, deliveries, digest, demo) | **DEFERRED** |

### Decisions and questions (Session B)

- **Decisions:** D-94 (OAuth refresh on 401, Salesforce reads), D-95 (Slack internal, once-only deliveries, digest), D-96 (setup wizard, keep-default), D-97 (Data health), D-98 (Chargebee), D-99 (real-time Today refresh).
- **Questions:** Q-54 (nested scopedDb read in a tenant transaction; found and fixed for tier bands), Q-55 (digest after the hourly Today rebuild), Q-56 (Slack card says "read-only"; copy fix at M6 start), Q-57 (Today refresh; fixed).

### Deferrals (each with its home)

- Live sandbox checks for all five connectors → **before M12**, or whenever sandbox credentials are provided (read checks only; live write-back stays off per D2).
- Slack card copy ("read-only" → "posts to your team only") → **start of M6** (Q-56).
- Proposed plays step in `/setup` and play-driven Slack steps → **M8**.
- Expansion CRM export (uses the write-back gate) → **M7**.
- Usage connectors through the same adapter interface and ingest → **M6**.
- The general Server Action / Route Handler enumeration test → **M12** (Q-50).
- Audit of nested `scopedDb` reads inside tenant transactions → **M12** (Q-54).

### Known risks

- **Rate limits:** a 429 is recorded in plain words and the next run resumes; there is no in-run backoff.
- **Stripe** reads full customer/subscription lists every run; fine at B2B volumes.
- **CRM incremental runs** rely on last-modified dates; deletions are seen on the next FULL run, and no periodic FULL is scheduled yet.
- **Salesforce field variability:** custom fields are not mapped; only standard Account/Contact/User/Opportunity fields are read.
- **Slack digest timing** follows the hourly Today rebuild, so it arrives within the hour after 07:00 workspace time.
- **Today rebuild on a real-time signal** rebuilds the whole workspace's Today; fine for M5 volumes, worth narrowing to the account owners when large workspaces arrive.

### Files changed

149 files against `a4ed077` (Session A 75; Session B 93 against `4b3e63c`, some overlapping), including fixtures for five providers, six evidence images, three migrations (`m5_integrations`, `m5_slack`, `m5_setup`), and these areas:

- `prisma/`: schema, migrations, seed (`--empty-workspace`);
- `src/modules/integrations/`: framework, adapters (5) with fixtures and tests, Slack, Data health, actions;
- `src/modules/setup/`: the wizard service, actions and tests;
- `src/app/`: Settings › Integrations, Settings › Data health, `/setup`, OAuth connect/callback, webhook and Slack interactivity routes;
- product files extended: approvals (write-back payload, outbox event), accounts (tier rule through the transaction, scan excludes conflicts), signals pipeline (sync flow), notifications (in-app only), settings tabs, worker, lib (env, logger, locks, queues, outbox, inbound lookups, workspace);
- scripts: `demo-webhook.ts`, secret patterns;
- e2e: `m5-integrations.spec.ts`, `a11y-m5.spec.ts`, `support/m5.ts`; `playwright.config.ts`;
- docs: this log, DECISIONS D-82 … D-99, QUESTIONS Q-50 … Q-57, CHANGELOG, IMPLEMENTATION_PLAN checkbox, CLAUDE.md commands, `.env.example`.

### What the next milestone should know

- **Adding a connector:** one `IntegrationAdapter` in `adapters/<provider>/` (+ `__fixtures__`, a contract test and a sync-twice test), registered in `adapters/index.ts`. Records go out only as normalized batches; `ingest.service` is the only writer. Usage connectors (M6) add normalized usage kinds to `normalized.ts` and a handler in ingest.
- **Real-time hook:** `processWebhookEvent` → `evaluateAndStore` for the affected accounts → `enqueueAccountEvaluation` → `rebuildWorkspaceToday` → `notifySignalsOpened`. Any new real-time source should follow it.
- **Setup wizard:** five steps; M8 inserts "Proposed plays" before Go live. `Workspace.setupPending` gates the nightly run.
- **Slack:** `deliverOnce` is the only way to post; M8 play steps reuse it. Sensitive approvals never get buttons.

