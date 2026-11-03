# M5 — Integrations Core: Log

**Status:** IN PROGRESS. Session A (framework, HubSpot, Stripe, Settings › Integrations) is done; Session B (Salesforce, Chargebee, Slack, Data health, setup wizard, e2e, close) has not started. M5 is **not** complete and the plan checkbox is not ticked.
**Baseline:** `a4ed077` (M4 docs commit), with M4's close numbers taken as recorded from this tree: gate 110 files / 1,078 tests; e2e 40 passed / 28 skipped. No suite was run at baseline.
**Carried, unchanged:** M1 #16 PARTIAL (Docker not installed). No docker command was run.
**Live services:** none called. There are no sandbox credentials in env; every connector so far is fixture-verified, with live verification **DEFERRED**.

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
  - Q-51: `update-attack.ts` gained four entries.
  - Q-52: Sundial can show more than one payment signal in the fixture world.
  - Q-53: `next dev` request log shows the OAuth callback URL.

### Deviations reported (none loosen a check)

- **M5.md §4 "each slice ends with `pnpm gate`"** is superseded by the founder's execution economics: targeted tests per slice, and one full `pnpm test` at the end of Session A.
- **M5.md names `oauth.test.ts` / `writeback.test.ts`:** both use the database, kept under those names.
- **Pre-M5 test files touched:** the four approved, plus `update-attack.ts` (Q-51).
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
