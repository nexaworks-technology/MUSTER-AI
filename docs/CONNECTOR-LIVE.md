# Connector live proof: Session A audit (2026-11-13)

Audit only: no live calls were made and no code was changed. Everything below is read from the code
at `a4048e5` (adapters in `src/modules/integrations/adapters/<provider>/`, the connect flow in
`src/modules/integrations/connections.service.ts` and `src/app/api/integrations/[provider]/`, the
Settings UI in `src/app/(app)/settings/integrations/page.tsx`, env in `src/lib/config/env.ts`,
fixtures in each adapter's `__fixtures__/`). Where the code does not say, this doc says
"not in code". Statements about how a vendor's live API behaves are marked
**(vendor behaviour, unverified here)**: they come from vendor documentation, not from this repo.

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

1. **[config/code] `docker-compose.yml` does not pass any connector variable to `web` or `worker`.**
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
  `https://app.hubspot.com/oauth/authorize`; token URL `https://api.hubapi.com/oauth/v1/token`;
  refresh-token rotation handled. **No private-app token path**: there is no form field to paste a
  token.
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
  1. Common blockers 1 (compose does not forward `HUBSPOT_*`) and 2 (stable hostname).
  2. A HubSpot developer account and app must be created and its client id/secret set (steps below).
  3. **Expansion export would fail if used:** it creates deals but `crm.objects.deals.write` is not
     in the requested scopes, so HubSpot would refuse it. Only matters once write-back is turned on.
  4. `crm.objects.companies.write` is requested at connect time even though write-back is off by
     default; the consent screen will show a write permission. Not a blocker; a disclosure point.

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
  1. **[code] The Settings connect form cannot connect Zendesk.** The adapter needs the subdomain
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
  1. **[code] The Settings connect form cannot connect Freshdesk.** The adapter needs the Freshdesk
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
  4. **[code] No paging or incremental read** (above): a live mailbox gets only its newest page,
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
  3. **[code] Delta paging** (above): a live mailbox larger than one page never syncs past page one.
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
  2. **[config] `RESEND_WEBHOOK_SECRET` is not in the env schema, not in `.env.example` and not
     forwarded by `docker-compose.yml`,** so bounce/complaint webhooks are always refused today.
     Code/config change needed.
  3. Common blocker 2 for the webhook URL.

---

## Blocker summary

| Connector | Code / config blockers (need a code session) | Founder / vendor actions |
|---|---|---|
| All OAuth (HubSpot, Salesforce, Slack, Gmail, Microsoft) | Compose does not forward `*_CLIENT_ID`/`*_CLIENT_SECRET` (and `SLACK_SIGNING_SECRET`) | Stable public hostname for redirect URIs |
| HubSpot | `crm.objects.deals.write` missing (export only) | Developer account + app, client id/secret |
| Salesforce | Sandbox login host hard-coded | Connected App; API-enabled edition |
| Stripe | none | Restricted read key; webhook secret if real-time wanted |
| Chargebee | none | Read-only key + site |
| Slack | (compose, above) | Slack app, bot scopes, redirect + interactivity URLs |
| Zendesk | **Connect form missing subdomain and admin email**; live comment bodies to check | API token |
| Freshdesk | **Connect form missing domain**; live paging/conversations to check | API key |
| Gmail | **No paging or incremental read** | Google project, consent screen, restricted-scope verification for external use |
| Microsoft | **Delta paging not followed** | Entra app registration, admin consent in some tenants |
| Resend | **`RESEND_WEBHOOK_SECRET` not in env schema / compose** | Verified sending domain, API key |

Stripe and Chargebee have no code blocker: they can connect live from Settings today on the native
dev server, and on Docker too (they need no env variables), for polling sync.

---

## HubSpot: step by step for the founder

This code expects **an OAuth app** (client id + client secret + redirect URL + scopes). It does not
accept a private-app access token. HubSpot's developer UI has changed recently; the names below
follow its developer platform as of late 2025 and may be worded slightly differently on screen.

**Before you start (needs a code/config session, see blockers):** a fixed public hostname for the
app, and `docker-compose.yml` forwarding `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` if you test
on the Docker stack. On the native dev server (`pnpm dev`) the second point does not apply.

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
     `docker-compose.yml`) gets the same two names, **and** the compose `web` and `worker` services
     must forward them (code/config change, blocker 1). Then recreate `web` and `worker`.
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
