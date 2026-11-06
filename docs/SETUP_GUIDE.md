# Setup guide: first day (for the pilot customer's Admin)

This guide follows the `/setup` wizard in the app (`src/app/(app)/setup/page.tsx`,
`src/modules/setup/service.ts`). Only an Admin can open it. Nobody else sees it.

The wizard has six steps, in this order: Connect, Import, Tiers and segments, Health model,
Proposed plays, Go live. You can leave and come back. Nothing runs nightly until you go live.

Product name in the app: see `src/config/product.ts`.

## Before you start

You need:

- Your account list as a CSV file (templates below), or a CRM or billing tool to connect.
- The email address of each CSM who will own accounts.
- A rough idea of the ARR size that separates your big, middle and small customers.

## Three things to know first

1. **Put `owner_email` on every account.** The Today page lists each member's own book
   (`src/modules/today/service.ts`, D-78). An account with no owner does not appear on a normal
   member's Today. If you import accounts with no owners, the first Today can read
   "Nothing needs you today" even when renewals are due. (QUESTIONS Q-88.) A member whose book scope is
   "Team" also sees the unowned accounts. Lost accounts are left out of Today.
2. **Nothing is sent to your customers without approval.** Drafts wait in Approvals until a person
   approves them. A play can send on its own only if an Admin turns auto-send on for it, and eight
   safety checks all pass (for example quiet hours and open urgent tickets). Messages about
   cancelling, price, legal, security, complaints or escalation never send on their own. (Rule 3;
   `src/modules/outbound/guards.ts`; checked in `docs/RULES_CHECK_MAP.md`.)
3. **Connections are read-only by default.** We read from your CRM, billing and support tools. We write back
   only if an Admin turns on "Allow write-back" for that one integration, ticks the specific
   fields, and each change is then approved by a person. (Rule 7; see "Write-back" below.)

## Step 1. Connect

Connect your CRM (HubSpot or Salesforce), billing (Stripe or Chargebee) and Slack. The Integrations
page also lists other connectors (for example Zendesk, Freshdesk, Mixpanel, Amplitude and the Usage
API). Connect only what you want.

- Open Settings > Integrations (`/settings/integrations`).
- Each data connection shows "Connected · read-only".
- Slack is different. It posts messages to your team, never to customers, so the page does not
  call it read-only.
- No integrations yet? Skip to step 2 and use CSV files. The product works with CSV only.

### Write-back (off by default)

On a connected integration that supports it, a section named "Write-back to <provider>" shows
"off". To turn it on, an Admin ticks "Allow write-back", ticks the fields to allow, and saves.
Each change is still written only after a person approves it. The setting is per integration and
per workspace. Turning it on or off is recorded in the audit log.
(Source: `src/app/(app)/settings/integrations/page.tsx`; tests in `src/modules/integrations/__tests__/writeback.test.ts`.)

There is a second switch for live pushes in the deployment settings (`WRITE_BACK_LIVE`, default off).
That one is set by whoever runs the deployment, not by an Admin in the app
(`src/modules/integrations/__tests__/writeback-live.int.test.ts`).

### Product usage through the Usage API (read this before you rely on it)

If you send product events through our Usage API (or Segment), we do **not** keep the raw events.
Events are folded into daily totals per account, per person and per feature, and then discarded.
So if usage reaches us only through the Usage API, we keep no raw event history and cannot answer
event-level questions later. Keep your own copy in your analytics tool if you need that.

Exactly what we keep (Q-33, D-23, D-110, D-117):

- Daily totals: `UsageDaily`, `UserUsageDaily`, `FeatureUsageDaily`.
- One ledger row per batch (`UsageIngestBatch`): a hash of the batch, the event count, which
  group ids matched no account, and which days were skipped. This lets a repeated batch change nothing.
- The events exist only inside the background job until it runs. The job is removed when it
  succeeds. After the final failed attempt, the events are replaced by a count
  (`src/modules/integrations/usage-api/job.ts`).

Mixpanel and Amplitude connections read counts from your own tool and keep only daily totals, so your
own tool holds the history. The Usage API key is created on the same Integrations page. It is shown once. See
`docs/ADMIN_GUIDE.md`.

## Step 2. Import

Choose "Sync <provider> now" for any connected source, or import CSV files at Settings > Import
(`/settings/import`). Every CSV is previewed before anything is saved. Importing the same file again
is safe: each template has a key that recognises a row you already imported.

Import order: accounts first. Then contacts and contracts, which point at accounts by `account_id`
or by the account's domain.

The wizard shows a running count of accounts, contacts and contracts. You need at least one
account to go live.

Download the templates from the Import page. Each template is a header row plus one example row.

### Accounts template (`accounts`; re-import key: `account_id`)

| Column | Required | Notes |
|---|---|---|
| `account_id` | Yes | Your own id for the account. |
| `name` | Yes | |
| `tier` | Yes | `high-touch`, `mid-touch` or `long-tail` (also `high`, `mid`, `long`). |
| `domain` | No | |
| `stage` | No | `onboarding`, `adopting`, `mature`, `renewing`, `lost`. |
| `owner_email` | No in the file, **do it anyway** | Email of the CSM who owns it. See "Three things to know". |
| `plan` | No | |
| `industry` | No | |
| `employee_band` | No | Company size, for example `51-200`. |
| `onboarding_started` | No | Date, for example `2026-10-01`. |

Tier is re-worked from ARR once a contract is imported, unless you set it here
(template description in `src/modules/imports/templates.ts`).

### Contracts template (`contracts`; re-import key: `contract_id`)

Amounts are whole currency units, for example `36000.00`.

| Column | Required | Notes |
|---|---|---|
| `contract_id` | Yes | |
| `account_id` or `account_domain` | One of the two | Links the contract to an account. |
| `start_date` | Yes | |
| `end_date` | No | |
| `renewal_date` | No | |
| `value` | No | Annual value. |
| `currency` | No | Three-letter code, for example `USD`. |
| `seats` | No | Seats bought. |
| `notice_days` | No | Notice period in days. |
| `auto_renew` | No | `yes` / `no`. |
| `status` | No | `active`, `ended`, `cancelled`. |

### Contacts template (`contacts`; re-import key: `contact_id`, or the email when there is no `contact_id`)

| Column | Required | Notes |
|---|---|---|
| `email` | Yes | |
| `name` | Yes | |
| `account_id` or `account_domain` | One of the two | |
| `contact_id` | No | |
| `title` | No | |
| `role` | No | `champion`, `decision maker`, `daily user`, `executive sponsor`, `billing`, `other`. |
| `status` | No | `active`, `bounced`, `left`. |
| `status_changed_at` | No | Date the status became true. |

### Other templates on the same page

| Template | Required columns | Re-import key |
|---|---|---|
| Invoices (`invoices`) | `invoice_number`, `amount`, `issued_date`, `due_date`, plus `account_id` or `account_domain` | `invoice_number` |
| Usage per account per day | `date`, `active_users`, plus `account_id` or `account_domain` | account + date |
| Usage per person per day | `user_id`, `date`, `events`, plus `account_id` or `account_domain` | account + `user_id` + date |
| Usage per feature per day | `feature_key`, `date`, `users`, plus `account_id` or `account_domain` | account + `feature_key` + date |
| Support tickets (`tickets`) | `ticket_id`, `subject`, `opened_at`, plus `account_id` or `account_domain` | `ticket_id` |
| Ticket messages (`ticket-messages`) | `message_id`, `ticket_id`, `sent_at`, `direction`, `body` | `message_id` |
| Outside signals | `kind`, `headline`, `source_url`, `event_date`, plus `account_id` or `account_domain` | account + `source_url` + `event_date` |

Files can be up to 25 MB (`MAX_UPLOAD_BYTES` in `src/config/uploads.ts`).

## Step 3. Tiers and segments

Tiers follow each account's ARR in your workspace's base currency. Accounts with no contract keep
the tier they have. You see three bands: high-touch from a figure, mid-touch up to it, long-tail below.

- Set the two figures and choose "Save tier bands". The high-touch figure must be above the
  mid-touch figure. Accounts whose tier follows the rule are re-tiered.
- Choose "Create the proposed segments" to add: High-touch accounts, Renewing in the next 90 days,
  Onboarding. Segments that already exist by name are left alone.

## Step 4. Health model

Choose "Run the back-test". It tests the scoring on your own renewed and churned accounts and
proposes a model with a plain sentence of what it found. The numbers come from the scoring engine,
not from AI (D-75). Then choose "Approve this model".

If your history is too thin to back-test, the page says so and offers "Keep the default model for
now". That choice is recorded in the audit log and lets you go live.

You can see details and edit weights later in Settings > Health model.

## Step 5. Proposed plays

The wizard proposes plays from what you connected and imported. Tick the ones you want and choose
"Create Proposed Play Drafts". They are created as drafts. They still go through the play safety
checks and approval before anything is published or sent.

## Step 6. Go live

Go live needs: at least one account, and an approved health model (or the default kept on
purpose). Then choose "Go live". It is recorded in the audit log, and the workspace is put on
the nightly schedule. After that, `/setup` stays open and you can revisit any step.

## Invite your team

Settings > Users (`/settings/users`). Enter an email, a role, and "Accounts they see". Tick "Revenue access"
only for people who should see ARR, contract values and forecasts. An invitation link is emailed and
expires after 7 days (`INVITATION_TTL_DAYS`, `src/modules/settings/service.ts`).

| Role | What it can do (from `src/lib/auth/permissions.ts`) |
|---|---|
| Admin | Everything, including users, settings, integrations, import, data export and delete, auto-send switch, activating a health model, audit export. |
| CS Leader | All accounts. Import data, propose health models, publish plays, send campaigns, view audit log and reports. Cannot manage users or settings, connect integrations, or export or delete data. |
| CSM | Works accounts in their own book scope: edit accounts, decide approvals, mark signals false alarm, set the pulse. Can draft plays and campaigns but not publish or send them. |
| Viewer | Read-only on accounts and reports. |

"Accounts they see" is Own accounts, Team, or All accounts. Revenue access is a separate switch
per person. It applies to every role, including Admin (`canViewRevenue`).

## What happens every night

For each live workspace, a job starts at 02:00 in the workspace's time zone (`src/worker/processors.ts`).
In order (ARCHITECTURE §1.2):

1. Connected integrations sync, reading only new changes.
2. Signal rules run over every active account.
3. Health scores are written, each with its reasons and source records.
4. Changes in health or signals can wake the AI team (for example the Health Analyst writes a
   short explanation). Drafts wait for approval.
5. Today is rebuilt for each member.
6. Outcome checkpoints (7, 30 and 90 days) are checked.

Also, every Monday at 07:00 in the workspace's time zone, the weekly digest is prepared for leaders.

If a job fails, an Admin can see it at Settings > System > Jobs (see `docs/ADMIN_GUIDE.md`).

## First-day checklist

- [ ] Accounts imported or synced, each with `owner_email`.
- [ ] Contracts imported (renewals and ARR depend on them).
- [ ] Tier bands saved. Segments created.
- [ ] Health model approved (or default kept on purpose).
- [ ] Plays reviewed.
- [ ] Team invited with the right roles and revenue access.
- [ ] Go live.
- [ ] Next morning: each CSM opens Today.
