# Connector live proof: Session A audit (2026-11-13)

Audit only: no live calls were made and no code was changed. Everything below is read from the code
at `a4048e5` (adapters in `src/modules/integrations/adapters/<provider>/`, the connect flow in
`src/modules/integrations/connections.service.ts` and `src/app/api/integrations/[provider]/`, the
Settings UI in `src/app/(app)/settings/integrations/page.tsx`, env in `src/lib/config/env.ts`,
fixtures in each adapter's `__fixtures__/`). Where the code does not say, this doc says
"not in code". Statements about how a vendor's live API behaves are marked
**(vendor behaviour, unverified here)**: they come from vendor documentation, not from this repo.

## Fix session (2026-11-13): blockers FIXED in `7015886`

Code blockers from this audit and from the Stripe proof (B1) were fixed test-first in commit
`7015886` (`fix(connectors): close the CONNECTOR-LIVE audit and B1 blockers`). Each blocker below is
marked **FIXED (`7015886`)** where it appears; the original finding text is kept for history.
Still open (not code): a stable public hostname (common blocker 2), rate-limit back-off (common
blocker 3), and the vendor checks marked "needs a live check".

| # | Blocker | Fix | Proof (tests) |
|---|---|---|---|
| 1 | Compose forwards no connector env to `web`/`worker` | Every name in `CONNECTOR_ENV_NAMES` (`src/lib/config/env.ts`) is forwarded to both services; also added the calendar and Zoom names the adapters read | `src/lib/config/__tests__/connector-env.test.ts` (compose, schema, `.env.example` and direct `process.env` reads kept in step) |
| 2 | `RESEND_WEBHOOK_SECRET` not in schema / `.env.example` | Added to both and to the connector list (so compose forwards it) | same file |
| 3 | Zendesk/Freshdesk form missing subdomain/domain/admin email; silent `app.*` fallback | Form fields added (Zendesk subdomain + admin email; Freshdesk domain), stored in the sealed credentials, passed to the adapters; a pasted address (`https://acme.zendesk.com/`) is reduced to `acme`; a missing value is refused before any request (`ConnectionSettingMissingError`) and shows as "Zendesk is missing its subdomain, so nothing was requested." on the card. The Settings action also did not accept `ZENDESK`/`FRESHDESK` at all; it now does | `src/modules/integrations/__tests__/support-key-settings.int.test.ts` |
| 4 | Gmail first page only, cursor unused; Outlook nextLink not followed, cursor not saved | Gmail: FULL follows `nextPageToken` (100 per page) to the end; INCREMENTAL reads `history.list` since the saved `historyId` (paged, deduplicated) and saves the newest one; a 404 (expired history) falls back to a full read. Outlook follows `@odata.nextLink` to the last page and saves its `$deltatoken`. Neither makes a cursor up from the clock any more; a repeated page token/link, or a Graph link off `graph.microsoft.com`, is refused | `adapters/google-email/__tests__/paging.test.ts`, `adapters/microsoft-email/__tests__/paging.test.ts` |
| 5 | B1: body-read timeout reported as "unexpected error" | `createLiveTransport` reads the body inside the error handling: any failure before the body is complete is `ProviderUnreachableError` ("… could not be reached") for every connector | `src/modules/integrations/__tests__/live-transport.test.ts` |
| 6 | B1: Account 360 › Billing hides subscriptions | Subscriptions table (plan, amount/interval, quantity, status, renewal date, source) always shown; "No contract on file" now stands in for the contract sections only; invoices also show without a contract. Amount is "Restricted" without revenue access | `src/modules/billing/__tests__/subscriptions-section.test.ts` |
| 7 | B1: no replace-key on a connected card | "Replace the … key" on every connected key-form card (Stripe, Chargebee, Mixpanel, Amplitude, Zendesk, Freshdesk), open by default when the card needs attention. `replaceApiKey` validates the new key with the provider using the saved settings, then swaps only the sealed key; integration id, `connectedAt`, settings, webhook secret and synced records stay; a refused key changes nothing. Audited (`integration.key_replaced` / `key_replace_failed`) without key values | `src/modules/integrations/__tests__/replace-key.int.test.ts` |

**Docker demo after the rebuild (same day, image built from `777d8aa`):** both `web` and `worker`
list all 20 connector names in their environment (names checked, values never printed; the demo
env file sets none, so they are empty and the connectors stay unconfigured). Muster Proof workspace:
PROOF Alpha's Billing tab shows "No contract on file" and, below it, its Stripe subscription
"PROOF Monthly · $360.00 / month · 3 · Active · Dec 1, 2026 · Stripe"
(`connector-evidence/fix-billing-subscriptions-no-contract.png`); the connected Stripe card offers
"Replace the Stripe key" (`fix-stripe-replace-key.png`); the Zendesk and Freshdesk forms show their
new fields (`fix-zendesk-form.png`, `fix-freshdesk-form.png`). A live replace-key against Stripe was
not run in this session (the proof keys are due to be revoked); it is covered by the tests above.

Not done, by design: Freshdesk got no admin-email field. Its adapter signs in with the API key
alone (`<key>:X`), so an email field would be collected and never used.

## How every connector works (shared)

- **One HTTP layer.** Adapters never call `fetch`; they use an `HttpTransport` (`transport.ts`).
  `INTEGRATIONS_TRANSPORT=live` (the default) uses real HTTPS with a 20 s timeout;
  `INTEGRATIONS_TRANSPORT=fixture` replays the recorded JSON in `__fixtures__/` and refuses any
  request it has no recording for. Production refuses `fixture`. So "live vs fixture" is the same
  adapter code; differences come only from what the vendor really returns.
- **Credentials** are sealed with AES-256-GCM (`FIELD_ENCRYPTION_KEY`) into
  `Integration.credentialsEnc`; never logged or returned.
- **OAuth** (`oauth.ts`, `connections.service.ts`): Admin-only. State is HMAC-signed with
  `AUTH_SECRET`, valid 10 minutes, tied to the member, the provider and an httpOnly nonce cookie.
  **Redirect URI is built as `${APP_URL}/api/integrations/<provider lower-case>/callback`**
  (`redirectUriFor`), e.g. `/api/integrations/hubspot/callback`,
  `/api/integrations/google_email/callback`. Tokens refresh automatically when expiring; a 401 forces
  one refresh and one retry (`sync.jobs.ts`).
- **API-key providers** connect through a form; the key is validated against the vendor before it
  is stored.
- **Webhooks**: `POST ${APP_URL}/api/integrations/<provider>/webhook/<integrationId>`, verified with
  that integration's own secret (entered on the connect form); unverified requests get 401. The
  Settings card shows the exact URL once connected.
- **Sync**: Settings "Run sync now" and a nightly BullMQ flow (`sync.jobs.ts`): job attempts 2,
  exponential backoff from 5 s. **No 429 / Retry-After handling** in the transport or sync engine:
  `ProviderHttpError` records `retryAfterSeconds` but nothing waits on it; a rate-limited run fails
  and is shown in plain words.
- **Write-back** (HubSpot, Salesforce owner + expansion deal; Gmail/Outlook drafts) needs an Admin
  switch per integration, an approval per change, **and** `WRITE_BACK_LIVE=true` for the live
  transport (`writeback.service.ts`, D-116). Default off.
- **What lands where** (`ingest.service.ts`, `ingest-conversations.ts`): owners → matched to
  members by email (unmatched listed, never guessed); CRM companies/accounts → `Account`;
  contacts → `Contact`; won deals/opportunities → `Contract` (only when the Admin turns it on);
  billing customers → **matched** to existing accounts by domain or contact email, never create one;
  subscriptions → `Subscription`; invoices → `Invoice`; tickets → `Ticket` + `Conversation` +
  `Message` + `InboxItem`; mail → `Conversation` + `Message` (kept only when it matches a known
  contact email or account domain, otherwise `UnmatchedInbound`). Every row keeps an `ExternalRef`.

### Blockers that apply to every connector

1. **FIXED (`7015886`).** **[config/code] `docker-compose.yml` does not pass any connector variable to `web` or `worker`.**
   Its `environment:` lists are explicit and contain none of `HUBSPOT_CLIENT_ID`,
   `HUBSPOT_CLIENT_SECRET`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `GOOGLE_EMAIL_CLIENT_ID`,
   `GOOGLE_EMAIL_CLIENT_SECRET`, `MICROSOFT_EMAIL_CLIENT_ID`, `MICROSOFT_EMAIL_CLIENT_SECRET`,
   `WRITE_BACK_LIVE` or `RESEND_WEBHOOK_SECRET`. The demo's override file (kept outside the repo)
   adds only `AUTH_URL` and the AI variables. **On the Docker stack every OAuth connect fails with
   "… CLIENT_ID and … CLIENT_SECRET are not set"** until these are forwarded. Native `pnpm dev`
   reads `.env` and is not affected. This is a code/config change; not made in this session.
2. **No stable public hostname.** The demo runs on a Cloudflare quick tunnel whose hostname changes
   whenever it restarts (three times this week). OAuth providers only redirect to a URI registered
   in advance, and webhook URLs embed `APP_URL`. Every hostname change breaks every registered
   redirect and webhook. A fixed hostname (named tunnel or real domain) is needed before any live
   OAuth connect is attempted.
3. **No rate-limit back-off** (see above). Not a blocker for a first small live sync; a risk on a
   large account.

---

## HubSpot

- **Auth as implemented:** OAuth 2.0 authorization-code flow (`kind: "oauth2"`). Authorize URL
  `https://app.hubspot.com/oauth/authorize`; token URL `https://api.hubapi.com/oauth/2026-03/token` (moved from the retired `/oauth/v1/token`, see below);
  refresh-token rotation handled. **No private-app token path**: there is no form field to paste a
  token.
- **Token endpoint (changed in the B2 session):** `POST /oauth/2026-03/token` for both the code
  exchange and the refresh, form-encoded, parameters in the body only. HubSpot's
  [v1 migration guide](https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/v1/migration-guide)
  retires `/oauth/v1/token` on 2027-02-16 and names `/oauth/2026-03/token` as the replacement (the
  code makes no revoke or introspect calls). Pinned by `adapters/hubspot/__tests__/token-endpoint.test.ts`.
- **Known later migration (logged, not done):** every CRM call is on `/crm/v3/` (owners, companies,
  contacts, deals, search, write-back). HubSpot's date-versioned API will replace it; horizon
  September 2027. Untouched here.
- **Scopes requested (exact strings, `HUBSPOT_SCOPES`):** `crm.objects.companies.read`,
  `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.owners.read`,
  `crm.objects.companies.write`.
- **Env names:** `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (plus `APP_URL`, `AUTH_SECRET`,
  `FIELD_ENCRYPTION_KEY`; `WRITE_BACK_LIVE` only for write-back).
- **Redirect URL:** `${APP_URL}/api/integrations/hubspot/callback`.
- **Syncs:** owners (`/crm/v3/owners`) → member matching by email; companies (+ archived ones on a
  FULL run) → `Account` (name, domain, owner, industry, employee band); contacts → `Contact`
  (name, email, job title, company via `associatedcompanyid`); deals → `Contract` only when
  "deals as contracts" is on and the stage equals `closedwon` (configurable). Connection test reads
  `/account-info/v3/details` (portal id, company currency).
- **Paging / incremental:** list endpoints `limit=100` + `after` cursor; INCREMENTAL uses the CRM
  search API with `hs_lastmodifieddate >= <last run start, ms>`. Polling only; no HubSpot webhooks.
- **Write-back (off by default):** PATCH company `hubspot_owner_id`; export creates a deal
  (`pipeline: default`, `dealstage: appointmentscheduled`, association type 5).
- **Live vs fixture differences (from code):** none in code paths. To check live
  **(vendor behaviour, unverified here)**: whether `associatedcompanyid` is returned on contacts and
  deals by the v3 objects API (if it is not, contacts and contracts arrive without their company);
  whether `/account-info/v3/details` needs an extra scope; HubSpot's search API rate limit.
- **Blockers, in order:**
  1. Common blocker 1 (compose forwarding) FIXED (`7015886`); common blocker 2 (stable hostname) still open.
  2. A HubSpot app must be registered and its client id/secret set. DONE in B2 (below), by the
     project-based route, not the legacy one.
  3. **Expansion export would fail if used:** it creates deals but `crm.objects.deals.write` is not
     in the requested scopes, so HubSpot would refuse it. Only matters once write-back is turned on.
  4. `crm.objects.companies.write` is requested at connect time even though write-back is off by
     default; the consent screen will show a write permission. Not a blocker; a disclosure point.

### Live proof B2, HubSpot, project-based app (2026-11-16): PASS, with findings below

**Registration finding: legacy apps are retired.** HubSpot has retired legacy apps on this account,
so the app is registered as a **developer project** (CLI), not in the old Apps UI. The HubSpot
developer docs now describe this as the only path. What was done, and what differed:

- **CLI:** `@hubspot/cli` 8.18.0 (`npm install -g @hubspot/cli@latest`; the docs page still says 7.6.0).
  Authenticated with a personal access key the founder pasted into their own terminal. The account
  the CLI signed in to is the portal `nexaworks` (247989832), which the CLI labels **standard**, not
  a developer account. Uploads worked there regardless.
- **Project:** `hs project create --project-base app --distribution private --auth oauth` with no
  features, platform version `2026.09`, created in `~/hubspot-muster-app` (outside this repo, which
  stays clean). `app-hsmeta.json`: name "Muster AI", distribution `private`, auth `oauth`,
  `requiredScopes` exactly the five the code sends (`crm.objects.companies.read`,
  `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.owners.read`,
  `crm.objects.companies.write`). The CLI template's default scopes (including `oauth`) were
  replaced. The support email, URL and phone fields are still the template's `example.com`
  placeholders; they did not block anything.
- **Upload:** `hs project upload`: build #1 built and deployed. HubSpot printed a warning that the
  `oauth` scope group "is required and has been automatically added" to the app's required scopes.
  The code does not send `oauth`; the consent screen accepted the connect anyway. No "update your
  platform" block was hit. Build #2 re-uploaded only to move the redirect URL (below).
- **Credentials:** client id and secret were copied by the founder into the project `.env`; this
  session copied just those two lines into the Docker stack's env file without printing them.
  Both reach `web` and `worker` (names checked in the container env, values never read).
- **Redirect URL** on the quick tunnel: `<tunnel>/api/integrations/hubspot/callback`. The quick
  tunnel hostname changed twice during the preparation; each change needs the `redirectUrls` edit
  and a re-upload. A stable hostname (common blocker 2) is still the real fix.

**Token endpoint changed first (`138b0ca`).** The code posted to `/oauth/v1/token`, which HubSpot
retires on 2027-02-16. HubSpot's migration guide names `/oauth/2026-03/token` (same form fields,
same response); both the code exchange and the refresh now use it, pinned by
`adapters/hubspot/__tests__/token-endpoint.test.ts` (written failing first). The live connect and
refresh went through it. The `/crm/v3/` calls are untouched (logged above as a later migration).

**Setup.** Developer test account "Muster Proof Test" (portal 248008004), seeded by hand: companies
PROOF Alpha, Beta, Gamma (domains `proof-alpha.test`, `proof-beta.test`, `proof-gamma.test`, matched
to the three accounts already imported by CSV in the Muster Proof workspace) and one billing contact
each. HubSpot rejects `.test` email addresses in every creation path, so the contacts use
`billing@proof-alpha.com`, `billing@proof-beta.com`, `billing@proof-gamma.com`. The HubSpot account
also holds HubSpot's two sample contacts, which have no company.

| # | Step | Result |
|---|---|---|
| 1 | Connect (founder's OAuth click, Muster Proof workspace) | **PASS**. Card "Connected · read-only", write-back off, `externalAccountId` 248008004 |
| 2 | First sync | **PASS on accounts**: 3 accounts matched, none duplicated. Contacts: Alpha and Beta created; **Gamma's contact missing** (step 3) |
| 3 | Gamma's contact | **PASS after a code fix** (`f02b9de`), see below |
| 4 | Changed field | **PASS**: Alpha Industry set to "Computer Software" in HubSpot; the next incremental sync updated the account (`fieldSources {"industry": "HUBSPOT"}`) |
| 5 | Changed contact field | **PASS**: Alpha's contact Job title set to "Billing Lead"; the same run updated the contact (`fieldSources {"title": "HUBSPOT"}`). This is the live proof of the contact fix |
| 6 | No-change sync | **PASS**: 0 added, 0 updated; account and contact `updatedAt` unchanged |
| 7 | Revoke | **PASS**: app uninstalled in HubSpot; Test connection and Run sync both fail honestly ("Needs attention", "HubSpot refused the request (HTTP 400)"), the run is recorded FAILED, and a fingerprint of all 6 records is identical before and after |
| 8 | Reconnect (founder's click) | **PASS**: card healthy again, same integration and `connectedAt`, final sync 0 added / 0 updated, data fingerprint unchanged |
| 9 | Webhooks | **DEFERRED**, same as Stripe: HubSpot sync is polling only in code, and the tunnel hostname is not stable |

Sync runs, in order (IST; counts are created / updated / unchanged / not matched):

| Time | Kind | Result | Note |
|---|---|---|---|
| 17:22:32 | FULL | 2 / 0 / 3 / 6 | contacts of Alpha and Beta created; Gamma's contact did not exist yet at the read |
| 17:25:51 | INCREMENTAL | 0 / 0 / 3 / 4 | |
| 17:35:54 | INCREMENTAL | 0 / 0 / 3 / 4 | Gamma still missing (the bug) |
| 17:42:36 | INCREMENTAL | 0 / 0 / 2 / 3 | first run on the fixed image: nothing new in its window |
| 17:43:08 | FULL | 1 / 0 / 5 / 6 | queued by hand to recover Gamma's contact |
| 17:49:06 | INCREMENTAL | 0 / 2 / 2 / 2 | Alpha industry and Alpha contact title |
| 17:50:35 | INCREMENTAL | 0 / 0 / 0 / 1 | no-change sync |
| 18:59:06 | INCREMENTAL | FAILED, HTTP 400 | app uninstalled |
| 19:06:33, 19:06:51 | INCREMENTAL | 0 / 0 / 0 / 1 | after the reconnect |

The "not matched" figures are plain-words problems, not errors: the HubSpot owner (the founder's
own address) is not a member of the Muster Proof workspace, so accounts stay with Proof Admin; and
HubSpot's two sample contacts have no company in the sync.

**Gamma's contact: timing first, then a real bug (`f02b9de`).** The contact was created in HubSpot
at 11:52:54Z, 22 seconds after the first sync read the contact list, so that run missing it was
timing. The later incremental runs should have found it and did not. Root cause, checked live
against HubSpot with the integration's own saved connection (read-only): for **contacts**, a search
on `hs_lastmodifieddate` is accepted (HTTP 200) but matches nothing, while `lastmodifieddate`
returned all three proof contacts; companies and deals are fine on `hs_lastmodifieddate`. So no
contact created or changed after the first full sync was ever read again. Fix: contacts use
`lastmodifieddate` (`MODIFIED_PROPERTY` in the HubSpot adapter), with a regression test pinning the
filter per object type (`incremental-filter.test.ts`, failing before the change). The existing test
had only pinned the companies filter, which is how it survived. The cursors of the earlier runs had
already moved past Gamma's contact, so the fix alone did not recover it; one FULL run, queued through
the real queue, did (1 contact created).

**Provenance** (stored, read from the database; the UI does not label CRM field sources): after the
change run, `Account.fieldSources` for PROOF Alpha is `{"industry": "HUBSPOT"}` and
`Contact.fieldSources` for `billing@proof-alpha.com` is `{"title": "HUBSPOT"}`. The contacts the connector created have `source = HUBSPOT`; the three accounts keep `source = CSV`, since the CSV import created them first and HubSpot only matched and updated them.

**Deviations from the plan.**
- Contacts use `billing@proof-*.com`, not `.test` (HubSpot refuses `.test` addresses).
- **Owner mapping is unproven in this setup:** the HubSpot owner (the founder's Gmail) is not a
  member of the Muster Proof workspace, so owners stayed Proof Admin and the card said so.
  Expected behaviour; matching a real member by email was not exercised.
- Webhooks deferred.
- The CLI signs in to a *standard* portal, not a developer account.

**Findings, not fixed in this session:**
1. **No "Source: HubSpot" label** on account Overview or People pages. The provenance is stored but
   not shown for CRM fields. Follow-up observation only.
2. **Records missed by an incremental run stay missed.** An incremental run never looks back past
   the last cursor, and the UI has no "full resync". A full run exists in code
   (`enqueueSync(..., "FULL")`) but is not reachable from Settings.
3. **A revoked app reads vaguely and has no reconnect path.** The card says "HubSpot refused the
   request (HTTP 400)" with no hint that the app was uninstalled; a revoked sign-in should say so
   and point at Reconnect. Once the card is "Needs attention" it offers only Disconnect; the
   reconnect in this proof was Disconnect, then Connect (the audit log shows both). Reconnecting
   kept the original `connectedAt`, as designed.
4. **A check made soon after an uninstall can still pass.** HubSpot revokes the refresh token on
   uninstall, but an access token already issued works until it expires (about 30 minutes).
5. **Live replace-key (B1 finding 3):** the audit log shows an `integration.key_replaced` entry for
   Stripe at 11:40:57Z (not made in this session), so that flow has run against real Stripe at least
   once.
6. `crm.objects.deals.write` is still not requested, so the expansion export would be refused if
   used (unchanged from the audit).

Evidence (`docs/connector-evidence/`): `b2-step1-sync-gamma-card.png`,
`b2-step1-gamma-people.png` (Gamma empty), `b2-step1-card-after-full.png`,
`b2-step1-gamma-people-after-fix.png`, `b2-step2-alpha-overview.png` (Industry "Computer Software"),
`b2-step2-alpha-people.png` (title "Billing Lead"), `b2-step2-sync-card.png`,
`b2-step3-nochange-sync.png`, `b2-step4-test-connection-revoked-2.png`, `b2-step4-sync-revoked.png`,
`b2-step4-final-sync.png`.

## Salesforce

- **Auth as implemented:** OAuth 2.0 authorization-code (web server) flow. Authorize/token host is
  **hard-coded to `https://login.salesforce.com`**. Token response's `instance_url` is stored and
  used for every API call. REST API version `v61.0`.
- **Scopes requested:** `api`, `refresh_token`.
- **Env names:** `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` (the Connected App's consumer
  key and secret).
- **Redirect URL:** `${APP_URL}/api/integrations/salesforce/callback`.
- **Syncs (SOQL via `queryAll`, so deleted rows come back flagged):** active `User` → member
  matching by email; `Account` (Name, Website, OwnerId, Industry, NumberOfEmployees) → `Account`;
  `Contact` → `Contact`; won `Opportunity` (Amount, CloseDate) → `Contract` only when turned on;
  `Organization.DefaultCurrencyIsoCode` for currency.
- **Paging / incremental:** follows `nextRecordsUrl`; INCREMENTAL adds
  `LastModifiedDate >= <last run start>`. Polling only.
- **Write-back (off by default):** PATCH `Account.OwnerId`; export POSTs a new `Opportunity`.
- **Live vs fixture:** same code. Sandbox orgs log in at `test.salesforce.com`, which the code
  cannot use.
- **Blockers, in order:**
  1. Common blockers 1 and 2.
  2. A Salesforce Connected App (or External Client App) with the callback URL and scopes above.
  3. **Sandbox orgs cannot connect** (login host hard-coded). A Developer Edition or production org
     works; a sandbox needs a code change.
  4. Salesforce API access must be enabled for the org edition used (vendor behaviour, unverified
     here: Professional Edition needs the API add-on).

## Stripe

- **Auth as implemented:** API key (`kind: "apiKey"`), sent as `Authorization: Bearer <key>`. The
  Settings help text asks for a **restricted key with read access to Customers, Subscriptions and
  Invoices**. Validated with `GET /v1/customers?limit=1`.
- **Env names:** none for the connection (the key is entered in Settings and stored sealed).
  `STRIPE_WEBHOOK_SECRET` exists only for the dev `demo:webhook` script, not for the app.
- **Redirect URL:** not OAuth; none.
- **Syncs:** customers → matched to existing accounts (never created); subscriptions →
  `Subscription`; invoices created in the last 400 days (`created[gte]`, `expand[]=data.charge`)
  → `Invoice`. Every run reads customers and subscriptions in full.
- **Paging:** `limit=100`, `starting_after`, stops on `has_more=false`.
- **Webhooks:** `invoice.payment_failed`, `invoice.paid`, `customer.subscription.updated`, verified
  with `Stripe-Signature` (HMAC, 5-minute tolerance) against the signing secret entered on the
  connect form ("Webhook signing secret").
- **Live vs fixture:** same code. Test-mode keys (`sk_test_…`/`rk_test_…`) work the same way
  against Stripe's test data (vendor behaviour, unverified here).
- **Blockers, in order:**
  1. Common blocker 2 for webhooks only (the webhook endpoint registered in Stripe embeds `APP_URL`).
     Polling sync works without it.
  2. A restricted key with those read permissions (founder action).
  3. Customers only match accounts whose domain or a contact's email already exists in Muster, so
     the CRM (or a CSV import) should be connected first or Stripe customers stay unmatched.

### Live proof B1, Stripe test mode (2026-11-13): PASS, with gaps named below

Run against the Docker demo (image `a4048e5`) in a separate workspace, **Muster Proof**
(`muster-proof`, admin `admin@muster-proof.test`), created by the create-only
`scripts/proof-workspace.ts` (it refuses if the workspace or admin exists; Larkspur untouched, still
72 accounts). Stripe account in **test mode**; no live key was used.

**Keys.** The app's key is the founder's restricted test key "Muster AI read", pasted by the founder
into Settings › Integrations › Stripe (never seen or logged by the agent). Seeding used a separate
restricted test key with Write on Customers, Products, Prices, Subscriptions and Invoices, read from
`STRIPE_PROOF_SEED_KEY` in the repo `.env` by `scripts/stripe-proof-seed.ts` (refuses non-test keys,
masks key fragments in Stripe errors, never prints the key). Both keys are to be revoked after the
session. The first seed attempts hit HTTP 403 because `.env` held the read key; the founder replaced
it with the write key.

**Step 2, seed (PASS).** Product "PROOF Plan", price "PROOF Monthly" USD 120.00 per unit per month,
collection "send invoice" (no payment method, nothing charged):

| Customer | Stripe customer | Subscription | Amount | Renews (current period end) |
|---|---|---|---|---|
| PROOF Alpha `billing@proof-alpha.test` | `cus_VcWbKBEbcqvwAG` | `sub_1UbHYfF8EaE0VfUbnIMh5zfI`, active, qty 3 | USD 360.00 / month | 2026-12-01 00:00 UTC |
| PROOF Beta `billing@proof-beta.test` | `cus_VcWbLdN86h3klT` | `sub_1UbHZEF8EaE0VfUbhfPApvUV`, active, qty 2 | USD 240.00 / month | 2026-12-10 00:00 UTC |
| PROOF Gamma `billing@proof-gamma.test` | `cus_VcWbCtQme7xU0i` | none | – | – |

Beta's renewal was planned for 2026-12-15; Stripe refuses a first renewal later than one billing
period ahead (about 2026-12-13 on 2026-11-13), so it is 2026-12-10. Stripe issued no invoices for these
subscriptions (no proration, future billing anchor), so 0 invoices is the correct expectation.
The test account also holds **28 older test customers** from before this session.

**Accounts first.** The 3 PROOF accounts (domains `proof-alpha.test`, `proof-beta.test`,
`proof-gamma.test`) were imported through the real Settings › Import screen before connecting:
"3 created, 0 updated, 0 unchanged, 0 failed".

**Step 3, first sync (PASS on data; one UI gap).** Settings card: "5 added, 0 updated, 0 unchanged,
28 not matched" (`docs/connector-evidence/b1-step3-first-sync.png`). The 28 are the older test
customers, each listed as "matches no account by domain or contact email, so its billing was not
linked" (correct: never guessed, never created). Database (`Subscription`, source `STRIPE`):

| Account | plan | interval | amount | qty | status | currentPeriodEnd |
|---|---|---|---|---|---|---|
| PROOF Alpha | PROOF Monthly | MONTH | 36000 minor = USD 360.00 | 3 | ACTIVE | 2026-12-01 00:00 |
| PROOF Beta | PROOF Monthly | MONTH | 24000 minor = USD 240.00 | 2 | ACTIVE | 2026-12-10 00:00 |

`ExternalRef` rows: Customer 3, Subscription 2. Invoices 0. Gamma linked, no subscription. In the
product, **Revenue › Expected billing** shows "Dec 2026 $600.00, 2 subscriptions" and the same for
the following five months (`b1-step3-revenue.png`): 360 + 240, matching exactly.
**Gap:** the **Account 360 › Billing tab never shows subscriptions**. `getBilling()` returns them,
but the page renders contracts and invoices only, and with no contract it stops at "No contract on
file" (`b1-step3-account360-billing-gap.png`). Not fixed in this session. Also by design: ARR comes
from contracts only, so these accounts show "no ARR on file" although they have subscriptions.

**Step 4, second sync (PASS).** "0 added, 0 updated, 5 unchanged, 28 not matched"
(`b1-step4-resync.png`). A database dump of every PROOF subscription, invoice, external ref and the
counts was byte-identical before and after, including `updatedAt`: zero duplicates, zero changes.

**Step 5, change flows in (PASS).** Beta's quantity changed in Stripe 2 → 5 (USD 600.00 / month,
renewal unchanged 2026-12-10). After sync, Beta's subscription is `amountMinor 60000`, `quantity 5`,
updated 2026-11-13 11:12:02 UTC, **same internal record** (`c6rwrriswahisqjipozt9mmkw`, no new row),
`source = STRIPE`, its `ExternalRef` still mapping `sub_1UbHZEF8EaE0VfUbhfPApvUV` through this
integration (provenance rule D-83: a provider updates in place a field it owns). Alpha unchanged.
Revenue › Expected billing now "Dec 2026 $960.00, 2 subscriptions" (`b1-step5-revenue-after-change.png`).
A follow-up sync was "0 added, 0 updated, 5 unchanged".
How it got there, honestly: the first sync after the change failed ("The Stripe sync stopped because
of an unexpected error", worker log `TimeoutError`), the second failed after writing Beta's update
("Stripe could not be reached" on the invoices request; batches commit as they go, so the
subscription update landed and was kept), the third succeeded. Direct checks from the worker container
reached Stripe in about 0.3 s, so these were transient network failures on this machine, not Stripe
errors. See "Found during B1" for the one code issue this exposed.

**Step 6, bad key (PASS).** Settings has no way to replace a connected key except Disconnect (which
would need the founder to paste the real key again), so the stored credential was swapped at the
database layer for a deliberately invalid test-shaped key, after an exact backup of the sealed value.
Sync then failed visibly and honestly: the card turned **"Needs attention"** with "Stripe rejected the
saved credentials. Paste a new restricted read-only key." and kept "Last successful sync"
(`b1-step6-bad-key.png`); the integration row went to `ERROR`; no record changed. The backup was
written back (byte-identical, checked), and the next sync succeeded: "0 added, 0 updated, 5 unchanged",
status `CONNECTED` (`b1-step6-restored.png`). The backup file was deleted.

**Step 7, webhooks: DEFERRED.** Stripe webhooks need an endpoint at a stable hostname (common blocker
2). The card shows a webhook address on the current quick tunnel, which will change; no webhook was
registered in Stripe. Polling sync is what was proven.

**Found during B1 (named, then fixed in `7015886`):**
1. **FIXED (`7015886`).** **[code] A timeout while reading a response body is reported as "unexpected error".**
   `createLiveTransport` maps fetch failures to `ProviderUnreachableError`, but `res.text()` is outside
   that `try`, so an abort during the body read escapes as `TimeoutError` and the card says "stopped
   because of an unexpected error" instead of "Stripe could not be reached".
2. **FIXED (`7015886`).** **[UI] Account 360 › Billing does not show subscriptions** (above).
3. **FIXED (`7015886`).** **[UI] No "replace key" for a connected API-key integration.** The bad-key message says "Paste a new
   restricted read-only key", but the card offers no field for it; the only path is Disconnect and
   connect again.
4. **[environment] The quick tunnel degraded mid-session** (Chromium `ERR_HTTP2_PING_FAILED`, page
   loads of 10 to 45 s); steps 5 and 6 were driven against the same Docker app on `localhost:3300`
   with the same signed-in session. The app's own **sign-in rate limit** (5 per email per 10 minutes)
   refused the proof scripts once; they were changed to sign in once and reuse the session.

## Chargebee

- **Auth as implemented:** API key + site (`kind: "apiKey"`), HTTP Basic with the key as user.
  Base URL `https://<site>.chargebee.com/api/v2`. Validated with `GET /customers?limit=1`.
- **Env names:** none (key, site and optional webhook credentials are entered in Settings).
- **Redirect URL:** none.
- **Syncs:** customers → matched to accounts; subscriptions (deleted ones skipped) →
  `Subscription`; invoices → `Invoice` (dunning attempts mark failed payments).
- **Paging / incremental:** `limit=100`, `offset` / `next_offset`; INCREMENTAL adds
  `updated_at[after]`.
- **Webhooks:** `payment_failed`, `payment_succeeded`. Chargebee does not sign webhooks; the code
  compares the request's HTTP Basic `Authorization` with the "username:password" entered on the
  connect form (constant time).
- **Live vs fixture:** same code.
- **Blockers, in order:**
  1. Common blocker 2 for webhooks only.
  2. A read-only API key and the site name (founder action); the Settings form has both fields.
  3. Same matching dependency as Stripe.

## Slack

- **Auth as implemented:** OAuth v2 bot install. Authorize URL `https://slack.com/oauth/v2/authorize`
  (`scope=` comma-separated), token exchange `oauth.v2.access`. Stores the bot access token; no
  refresh (Slack bot tokens do not expire unless rotation is enabled; refresh is a no-op in code).
- **Bot scopes requested:** `chat:write`, `im:write`, `users:read`, `users:read.email`.
  No user scopes.
- **Env names:** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (interactivity),
  `SLACK_DELIVERY=live` (production refuses `log`).
- **Redirect URL:** `${APP_URL}/api/integrations/slack/callback`.
  **Interactivity request URL:** `${APP_URL}/api/integrations/slack/interactivity` (Approve/Reject
  buttons; signing secret + 5-minute timestamp window checked first).
- **Syncs:** nothing into customer records. Reads `users.list` to link members by verified email;
  posts approval requests, big signals and a morning digest as DMs (`chat.postMessage`).
- **Live vs fixture:** same code; Slack's "HTTP 200 with ok:false" errors are converted.
- **Blockers, in order:**
  1. Common blockers 1 (compose does not forward `SLACK_CLIENT_*`, `SLACK_SIGNING_SECRET`) and 2.
  2. A Slack app with those bot scopes, the redirect URL and the interactivity URL.
  3. Sensitive decisions are refused from Slack by design (`SENSITIVE_DECISIONS_FROM_SLACK`); not a
     blocker, a behaviour to expect.

## Zendesk

- **Auth as implemented:** API token (`kind: "apiKey"`), HTTP Basic `<admin email>/token:<token>`.
  Base URL `https://<subdomain>.zendesk.com`. Validated with `GET /api/v2/users/me.json`.
- **Env names:** none (meant to be entered in Settings).
- **Redirect URL:** none.
- **Syncs:** `GET /api/v2/incremental/tickets.json?start_time=<cursor>` → `Ticket`, its comments →
  `Message`, matched to accounts by requester email/domain (unmatched go to the unmatched queue).
- **Paging:** one request per sync run; the next run continues from the returned cursor. Not a loop.
- **Webhooks:** HMAC-SHA256 over timestamp + body with `X-Zendesk-Webhook-Signature` and
  `-Timestamp`, 5-minute tolerance, against the secret entered on the connect form.
- **Live vs fixture differences:** the fixture's tickets carry a `comments` array. **(vendor
  behaviour, unverified here)** the live incremental tickets endpoint does not return comments
  inline, so live tickets may arrive with no message bodies. One page per run also means a large
  backlog takes many runs.
- **Blockers, in order:**
  1. **FIXED (`7015886`).** **[code] The Settings connect form cannot connect Zendesk.** The adapter needs the subdomain
     (`site`) and the admin email (`username`), and the help text asks for both, but the form only
     renders a site field for Chargebee and a user-name field for Mixpanel/Amplitude. Without them
     the adapter falls back to the subdomain `app` (`app.zendesk.com`) and an empty email, so the
     validation call fails. Code change needed; stopped here per the brief.
  2. Comment bodies on live tickets (above): needs a live check, likely a code change.
  3. Common blocker 2 for webhooks only.

## Freshdesk

- **Auth as implemented:** API key (`kind: "apiKey"`), HTTP Basic `<key>:X`. Base URL
  `https://<domain>.freshdesk.com/api/v2`. Validated with `GET /tickets?per_page=1`.
- **Env names:** none.
- **Redirect URL:** none.
- **Syncs:** `GET /api/v2/tickets?include=conversations,requester[&updated_since=<cursor>]` →
  `Ticket` + `Message`, matched like Zendesk.
- **Paging:** one request per run, no `page` parameter; the cursor is the newest `updated_at` seen.
- **Webhooks:** Freshdesk has no native signing; the code requires a shared secret in an
  `X-Freshdesk-Webhook-Secret` header that the Admin adds to the Freshdesk automation, compared in
  constant time.
- **Live vs fixture differences:** **(vendor behaviour, unverified here)** the list-tickets endpoint
  may not accept `include=conversations` (Freshdesk documents conversations on the single-ticket
  view), and its default page size is 30, so live runs may return fewer tickets per run and no
  conversation bodies.
- **Blockers, in order:**
  1. **FIXED (`7015886`).** **[code] The Settings connect form cannot connect Freshdesk.** The adapter needs the Freshdesk
     domain (`site`); the form has no site field for Freshdesk, so the domain falls back to `app`
     (`app.freshdesk.com`). Code change needed; stopped here.
  2. Paging and `include=conversations` on live data (above): needs a live check.
  3. Common blocker 2 for webhooks only.

## Gmail

- **Auth as implemented:** Google OAuth 2.0, authorize `https://accounts.google.com/o/oauth2/v2/auth`
  with `access_type=offline` and `prompt=consent`; token `https://oauth2.googleapis.com/token`.
- **Scopes requested:** `https://www.googleapis.com/auth/gmail.readonly`,
  `https://www.googleapis.com/auth/gmail.compose` (compose is for the draft write-back).
- **Env names:** `GOOGLE_EMAIL_CLIENT_ID`, `GOOGLE_EMAIL_CLIENT_SECRET`.
- **Redirect URL:** `${APP_URL}/api/integrations/google_email/callback` (note the underscore).
- **Syncs:** `GET /gmail/v1/users/me/messages`, then one `GET …/messages/<id>` per message →
  `Conversation` + `Message` (direction from the SENT label or the mailbox address), kept only when
  it matches a known contact or account domain.
- **Live vs fixture differences (from code):** the list call sends **no `pageToken`, `maxResults` or
  query**, so each run reads only the first page Gmail returns (vendor default, unverified here:
  100 newest messages). `nextPageToken` is parsed but never followed, and the stored cursor
  (`historyId`) is never used: every run re-reads the newest page. One request per message adds up
  against Gmail's quota. An unparseable `Date` header falls back to the current time.
- **Blockers, in order:**
  1. Common blockers 1 and 2.
  2. A Google Cloud project, OAuth consent screen and Web client with the redirect URI above.
  3. **Google verification:** `gmail.readonly` and `gmail.compose` are restricted scopes
     **(vendor behaviour, unverified here)**. In "Testing" status only listed test users can
     connect, and refresh tokens expire after 7 days; external production use needs Google's
     verification and a security assessment.
  4. **FIXED (`7015886`).** **[code] No paging or incremental read** (above): a live mailbox gets only its newest page,
     re-read every run. Code change needed for real use.

## Microsoft (Outlook)

- **Auth as implemented:** Microsoft identity platform v2, **`common` tenant** (work, school and
  personal accounts): authorize/token at `https://login.microsoftonline.com/common/oauth2/v2.0/…`.
- **Scopes requested:** `Mail.Read`, `Mail.ReadWrite`, `offline_access`, `User.Read`
  (ReadWrite is for the draft write-back).
- **Env names:** `MICROSOFT_EMAIL_CLIENT_ID`, `MICROSOFT_EMAIL_CLIENT_SECRET`.
- **Redirect URL:** `${APP_URL}/api/integrations/microsoft_email/callback`.
- **Syncs:** `GET /v1.0/me/mailFolders/inbox/messages/delta` → `Conversation` + `Message`
  (inbox only; sent mail is not read).
- **Live vs fixture differences (from code):** only the first delta page is read; `@odata.nextLink`
  is parsed but not followed. The delta token is saved only when the first page already carries
  `@odata.deltaLink`, which **(vendor behaviour, unverified here)** happens only when everything
  fits on one page; on a real mailbox the cursor is never saved and every run restarts from page one.
- **Blockers, in order:**
  1. Common blockers 1 and 2.
  2. An Entra ID (Azure AD) app registration, multi-tenant + personal accounts, Web redirect URI
     above, client secret, delegated permissions above.
  3. **FIXED (`7015886`).** **[code] Delta paging** (above): a live mailbox larger than one page never syncs past page one.
  4. Organisation tenants may require admin consent for `Mail.ReadWrite` (vendor behaviour,
     unverified here).

## Resend (email out)

- **Auth as implemented:** API key, `Authorization: Bearer`, `POST https://api.resend.com/emails`
  (staff email `src/lib/email/resendTransport.ts`; customer email `customerTransport.ts` /
  `resendHttp.ts` with an idempotency header).
- **Env names:** `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (production refuses `log`
  and requires both). **Delivery webhook:** `RESEND_WEBHOOK_SECRET` (or `EMAIL_WEBHOOK_SECRET`),
  read directly from `process.env` in `src/modules/campaigns/webhook.ts`.
- **Webhook URL:** `${APP_URL}/api/email/webhook`, Svix signature (`svix-id`, `svix-timestamp`,
  `svix-signature`, 5-minute tolerance). Without the secret every delivery event is refused (401).
- **Live vs fixture:** the e2e and dev runs use the `log` transport; Resend has never been called.
- **Blockers, in order:**
  1. A Resend account, a **verified sending domain** for `EMAIL_FROM` (the Docker demo still has the
     placeholder `verify@example.test`), and an API key.
  2. **FIXED (`7015886`).** **[config] `RESEND_WEBHOOK_SECRET` is not in the env schema, not in `.env.example` and not
     forwarded by `docker-compose.yml`,** so bounce/complaint webhooks are always refused today.
     Code/config change needed.
  3. Common blocker 2 for the webhook URL.

### Live proof B3, Resend (2026-11-16): PASS for send and honest failure, with two findings

Workspace Muster Proof, Docker stack (web :3300, worker). No key value was printed anywhere; keys
are described only by length and prefix. Evidence: `docs/connector-evidence/b3-step2-invite-sent.png`,
`b3-step4-wrong-key.png`, `b3-step5-restored-send.png`.

**1. Live transport proven.** Web and worker containers: `EMAIL_TRANSPORT=resend`,
`EMAIL_FROM=Muster AI <hello@send.nexaworks.tech>`, `RESEND_API_KEY` length 36, prefix `re_` (not the
old 29-character placeholder), `RESEND_WEBHOOK_SECRET` unset. The app's own `env()` parses and the
staff path selects the Resend HTTP transport. A read-only `GET https://api.resend.com/domains` from
the web container returned HTTP 200: `send.nexaworks.tech` **verified** (ap-northeast-1) and
`nexaworks.tech` verified (eu-west-1). The key is therefore a full-access key; a sending-only key
would be enough for the app and is the better choice for production.

**2. Real send (the member invite).** Settings › Members, role CSM, `sahilghewari6@gmail.com`, 15:06:58 UTC.
Form: "Invitation sent to sahilghewari6@gmail.com."
- Resend (API listing): id `01a1e4e5-a8ec-7b33-a895-d299e51710ff`, from `Muster AI <hello@send.nexaworks.tech>`,
  to `sahilghewari6@gmail.com`, subject "Proof Admin invited you to Muster Proof on Muster AI",
  last event **delivered**.
- Inbox: confirmed by the founder (Rocky) in Gmail: in the Inbox (tabs Updates, Important), not spam,
  From exactly as set. Cited from the founder's report, no screenshot of the inbox is stored.
- App record: one `Invitation` row (CSM, pending, expires 2026-11-23) and one `invitation.created` audit
  entry ("Invited sahilghewari6@gmail.com as CSM").
- **Not recorded by the app:** Resend's message id and any delivery status. The only way the app
  could learn "delivered/bounced" is the webhook, which is deferred (below). Delivery is therefore
  proven here from Resend's side and the inbox, not from an app screen.

**3. Honesty test (wrong key).** The stack env file got an obviously invalid key (`re_WRONGKEY...`),
web and worker were recreated (environment change only, no code change, so no image rebuild),
and the same invite was sent at 16:09:32 UTC.
- Form showed: **"Something went wrong. Nothing was changed. Try again."** A failure, never a success
  message. Web log: `Email provider rejected the message (HTTP 401)`.
- Resend showed **no new email** (still the single 15:06 message).
- Records the failed attempt created: a new `Invitation` row (`cmwjglcy00001pv0yp4780zxg`, pending),
  one `invitation.created` audit entry (16:09:32), and it **revoked** the earlier pending invitation
  (`cmwjecw870001o90xc0veaf84`, `revokedAt` 16:09:32.613) that had been delivered. Nothing else.
- Verdict: no fake success. But see finding F1.

**4. Restore and re-prove.** The real key was restored from the founder's repo `.env`, web and worker
recreated. Same containers show `resend`, the `send.nexaworks.tech` From, length 36, prefix `re_`;
the same read-only `/domains` call returned HTTP 200 with `send.nexaworks.tech` verified. A new
invite at 16:10:15 UTC: form "Invitation sent to sahilghewari6@gmail.com."; Resend id
`01a1e51f-9aaf-71d3-89d8-aba39f129a36`, delivered; the failed-attempt invitation was revoked by this
send (as designed for a re-invite) and `cmwjgmaal0001pf0y6j4hzet9` is the one pending invitation.

**5. Webhook: DEFERRED.** Not registered, on the founder's decision: the delivery webhook needs a
stable public hostname (`${APP_URL}/api/email/webhook`), and the current URL is a Cloudflare quick tunnel
whose hostname changes on every restart. Registering it there would break silently. Until it is
registered with `RESEND_WEBHOOK_SECRET` set, every delivery event is refused (401) and the app
shows no delivery status.

**Findings (no code changed in this session, as instructed):**
- **F1 [truthfulness, member invite]:** the invitation and its audit entry are committed *before* the
  email is sent. When the send fails the form says "Nothing was changed", which is **false**: an unsent
  pending invitation exists, and a previously delivered pending invitation for the same address was
  revoked (the person's earlier valid link is now dead). The error is also generic (the user is not told
  the email failed, so cannot tell "retry" from "fix the mail setup"). Suggested fix: send first, or
  roll back/mark the row `delivery failed` and say "The invitation was saved but the email could not be
  sent", and revoke the older invite only after a successful send.
- **F2 [observability]:** no provider message id and no delivery status stored for staff email, so
  nothing in the app can prove a given email was delivered. Store the Resend id on the invitation
  (or an email-log row) and fill the status from the webhook once it is registered.
- Deviations during setup: the key was first placed in the repo `.env` rather than the stack env file
  compose reads (copied across); the `EMAIL_FROM` line in the repo `.env` has a stray `→` character and
  `EMAIL_TRANSPORT=log` there, so the stack env file was set from the founder's stated From value instead.
  The repo `.env` was not modified.
- Reminder: the key is full-access; rotate/replace with a sending-only key when convenient.

---

## Blocker summary

| Connector | Code / config blockers (need a code session) | Founder / vendor actions |
|---|---|---|
| All OAuth (HubSpot, Salesforce, Slack, Gmail, Microsoft) | ~~Compose does not forward `*_CLIENT_ID`/`*_CLIENT_SECRET` (and `SLACK_SIGNING_SECRET`)~~ FIXED (`7015886`) | Stable public hostname for redirect URIs |
| HubSpot | **Live proof B2 PASS** (project-based app); token endpoint moved to `/oauth/2026-03/token` (`138b0ca`); contact incremental search fixed (`f02b9de`); open: `crm.objects.deals.write` missing (export only), vague revoked-app message, no full resync | Project-based app registered and installed (done); stable hostname |
| Salesforce | Sandbox login host hard-coded | Connected App; API-enabled edition |
| Stripe | **Live polling sync proven (B1)**; B1 findings (body-read timeout wording, Account 360 subscriptions, replace-key) FIXED (`7015886`) | Restricted read key; webhook secret if real-time wanted |
| Chargebee | none | Read-only key + site |
| Slack | (compose, above) | Slack app, bot scopes, redirect + interactivity URLs |
| Zendesk | ~~Connect form missing subdomain and admin email~~ FIXED (`7015886`); live comment bodies to check | API token |
| Freshdesk | ~~Connect form missing domain~~ FIXED (`7015886`); live paging/conversations to check | API key |
| Gmail | ~~No paging or incremental read~~ FIXED (`7015886`) | Google project, consent screen, restricted-scope verification for external use |
| Microsoft | ~~Delta paging not followed~~ FIXED (`7015886`) | Entra app registration, admin consent in some tenants |
| Resend | ~~`RESEND_WEBHOOK_SECRET` not in env schema / compose~~ FIXED (`7015886`) | Verified sending domain, API key |

Stripe and Chargebee have no code blocker: they can connect live from Settings today on the native
dev server, and on Docker too (they need no env variables), for polling sync.

---

## HubSpot: step by step for the founder

This code expects **an OAuth app** (client id + client secret + redirect URL + scopes). It does not
accept a private-app access token. HubSpot's developer UI has changed recently; the names below
follow its developer platform as of late 2025 and may be worded slightly differently on screen.

**Before you start:** a fixed public hostname for the app (still open, common blocker 2).
`docker-compose.yml` now forwards `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` to `web` and
`worker` (FIXED in `7015886`), so only the env file needs them.

1. **Account type:** create a free **HubSpot developer account** at developers.hubspot.com (this is
   separate from a CRM portal). Inside it, create a **developer test account** if you want a sandbox
   CRM with demo data; or use your real HubSpot CRM portal when you connect in step 7.
2. **App type:** in the developer account, go to **Apps** and **Create app** (a public / OAuth app;
   in the newest UI this is an app created in a developer project with **OAuth** authentication,
   distribution "private" or "marketplace" both work for a single portal). Name it "Muster AI".
3. **Redirect URL:** on the app's **Auth** tab add exactly
   `<APP_URL>/api/integrations/hubspot/callback`, where `<APP_URL>` is the app's public URL with no
   trailing slash (for the native dev server on your machine: `http://localhost:3000/api/integrations/hubspot/callback`).
   It must match character for character, or HubSpot refuses the redirect.
4. **Scopes:** on the same tab, add these as **required** scopes, each by name:
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.objects.owners.read`
   - `crm.objects.companies.write`

   If HubSpot insists on the `oauth` scope for every app, add it too; the code does not request it
   explicitly (not in code). Do **not** add `crm.objects.deals.write` unless you want the expansion
   export later; the code does not request it yet (blocker above).
5. **Copy the credentials** from the Auth tab: **Client ID** and **Client secret**.
6. **Put them in the env file** (names only here; never paste values into chat or commit them):
   - Native dev server: the repo's `.env` (gitignored) gets `HUBSPOT_CLIENT_ID=` and
     `HUBSPOT_CLIENT_SECRET=`, and `APP_URL=` set to the same base URL as in step 3. Restart
     `pnpm dev`.
   - Docker stack: the env file passed to `docker compose --env-file` (for the demo, the
     `docker.env` kept outside the repo; for a real deployment, the `.env` next to
     `docker-compose.yml`) gets the same two names; compose forwards them to `web` and `worker`
     (FIXED in `7015886`). Then recreate `web` and `worker`.
   - Leave `INTEGRATIONS_TRANSPORT` unset (it defaults to `live`) and `WRITE_BACK_LIVE` unset (no
     writes to HubSpot).
7. **Connect:** sign in to Muster AI as an **Admin**, open **Settings › Integrations**, click
   **Connect HubSpot**, choose the HubSpot portal (your CRM or the developer test account) on
   HubSpot's consent screen and approve. You return to Settings with "connected" and the portal id.
8. **First sync:** click **Run sync now** on the HubSpot card (or wait for the nightly run). The card
   then shows added / updated / unmatched counts; owners whose email does not match a Muster member
   are listed, and their accounts stay unassigned.
9. **Optional:** turn on "deals as contracts" only if your closed-won deal amounts are annual
   contract values; the stage used is `closedwon` unless set otherwise.
