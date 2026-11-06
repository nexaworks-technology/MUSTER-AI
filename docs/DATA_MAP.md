# Data map (DPA-ready draft)

M12: entities, purpose, retention, subprocessors. This is a map of what the code stores. It is not
a legal document and makes no certification claim. Statements here were checked against the code
on the date of writing. Where a point could not be checked it says "Not verified".

Product name: see `src/config/product.ts`. Pricing is not covered.

Sources of truth used: `prisma/schema.prisma`, `src/lib/db/tenantModels.ts`,
`src/modules/settings/data-controls/`, `docs/DECISIONS.md` (D-23, D-110, D-117, D-179, D-180,
D-183, D-184), `docs/QUESTIONS.md` (Q-10, Q-20, Q-33), `docs/SECURITY.md`.

## 1. Reading this map

- **[W]** = workspace-scoped model (`TENANT_MODELS`). Every row has a `workspaceId`, and the database
  filters by it (row-level security). **[G]** = global model (`GLOBAL_MODELS`): not tenant data.
- **Default retention.** No code prunes tenant rows on a timer, except where this map says
  otherwise. Such rows are "kept until the workspace is deleted". (I looked for `deleteMany` calls
  outside the purge path: the only ones are listed in section 5.)
- **Workspace deletion** (section 5) removes all [W] rows and the stored files.
- The Prisma schema has 85 models: 78 [W] and 7 [G]. Section 3 lists all of them.

## 2. Whose data is it

The customer (the workspace) is the owner of the account, contact, usage, support and call data it
puts in or connects. Personal data in the system mostly belongs to the customer's own customers
(contact names, work emails, titles, message text) and to the customer's staff (members).

## 3. Entities by domain

### 3.1 People who use the product (staff of the customer)

| Models | Personal or customer data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `User` [G], `AuthAccount` [G], `Session` [G], `VerificationToken` [G] | Email, name, image, password hash (credentials sign-in); for Google sign-in, provider account id and tokens (access and refresh tokens are encrypted by `src/lib/auth/adapter.ts`); session token and expiry | Sign in | The user; Google if used | Sessions last 30 days (`SESSION_MAX_AGE_SECONDS`, `src/lib/auth/config.ts`). No code deletes expired session rows (not verified beyond a search for `deleteMany`). `User` rows are global: the purge removes the workspace and its [W] rows, and `src/lib/db/deletion.ts` does not delete `User` rows. Not verified: what happens to a `User` with no remaining membership. |
| `Membership` [W], `Invitation` [W] | Member role, book scope, revenue-visibility flag; invited email, invitation token hash | Access control | Admin invites | Invitation link expires after 7 days (`INVITATION_TTL_DAYS`, `src/modules/settings/service.ts`). Membership and invitation rows: until the workspace is deleted. |
| `WorkspaceSettings` [W], `Workspace` [G] | Workspace name, slug, time zone, currency, settings (tier bands, auto-send switch and so on) | Configuration | Admin | Until the workspace is deleted. The `Workspace` row itself is deleted by the purge. |
| `AskThread`, `AskMessage` [W] | Each member's Ask AI questions, answers, tool calls, citations | Ask AI history | The member | Until the workspace is deleted. |

### 3.2 Audit and instrumentation

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `AuditLog` [W] | Actor type and id, action, target, plain summary, before and after values (secret-looking keys are redacted), IP address | Audit trail (Rule 5) | System, every write | Append-only (database trigger). Removed only by workspace purge after the grace period (D-179). |
| `ProductEvent` [W] | Member id, event name from a closed list (`today.opened`, `approvals.opened`, `approval.decided`, `signal.flag_accepted`, `signal.false_alarm`, `brief.generated`, `brief.shared`, `qbr.generated`, `qbr.shared`), subject id, and `props` limited to booleans, numbers and short strings without spaces. No customer content. | Pilot metrics page (D-183) | Server-side capture of member actions | Append-only. Removed by workspace purge. |
| `OutboxEvent` [G], `WorkspaceTombstone` [G] | Outbox: event type and a payload of ids. Tombstone: workspace slug, who asked for deletion (user id), dates, per-model row counts after purge | Reliable job hand-off; proof that a deletion happened | System | Outbox rows go with the workspace (cascade). The tombstone is kept after the purge by design (it records the deletion). |

### 3.3 Accounts and people at the customer's customers

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Account` [W] | Company name, domain, tier, stage, plan, industry, size band, owner | The thing being managed | CSV import (`accounts`), CRM sync (HubSpot, Salesforce), the user | Until the workspace is deleted. |
| `Contact`, `StakeholderRole` [W] | Name, email, title, previous title, time zone, status, role on the account | Who to talk to; champion tracking | CSV (`contacts`), CRM sync, email/ticket connectors, the user | Until the workspace is deleted. |
| `ExternalRef`, `Segment`, `FeatureCatalog` [W] | Ids in other systems; saved filters; the customer's feature names | Linking and filtering | Connectors, the user | Until the workspace is deleted. |

### 3.4 Commercial data

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Contract` [W] | Dates, annual value, currency, seats, notice, auto-renew, status; terms and pricing notes in encrypted columns (`termsEnc`, `pricingNotesEnc`) | Renewals, ARR | CSV (`contracts`), CRM (closed-won deals when turned on), uploads | Until the workspace is deleted. |
| `Subscription`, `Invoice`, `RevenueEvent` [W] | Amounts, billing status, payment events | Billing health, revenue | CSV (`invoices`), Stripe, Chargebee | Until the workspace is deleted. |
| `Renewal`, `RenewalOutcome`, `ExpansionOpportunity` [W] | Renewal status, forecasts computed by code, recorded outcomes | Renewals and expansion | System, the user, agent drafts | Until the workspace is deleted. |

### 3.5 Product usage

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `UsageDaily`, `UserUsageDaily`, `FeatureUsageDaily` [W] | Daily totals per account, per person (a user id from the customer's product, linked to a contact when emails match), per feature | Adoption and engagement | CSV usage templates, Mixpanel, Amplitude, Usage API, Segment | Until the workspace is deleted. |
| `UsageIngestBatch` [W] | A hash of each batch, the event count, group ids that matched no account (capped), skipped days | Makes a repeated batch change nothing | Usage API | Until the workspace is deleted. |
| `UsageBaseline` [W] | Computed baselines per cohort | Health scoring | System | Until the workspace is deleted. |

**Raw usage events are not stored.** See section 7.

### 3.6 Conversations, support and meetings

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Conversation`, `Message` [W] | Email sender and recipient addresses, subject, body text | Inbox, signals, promises | Gmail, Microsoft Graph, ticket tools, CSV (`ticket-messages`) | Until the workspace is deleted. |
| `Ticket` [W] | Subject, status, priority, requester | Support health | Zendesk, Freshdesk, CSV (`tickets`) | Until the workspace is deleted. |
| `CallTranscript` [W] | Call title, full transcript text and segments | Extractions, QBR, briefs | Transcript upload (WebVTT and similar) | Until the workspace is deleted. |
| `InboxItem`, `UnmatchedInbound` [W] | Inbound email sender, recipients, subject, body, candidate accounts | Inbox triage | Email connectors | Until the workspace is deleted. |
| `Meeting`, `MeetingAttendee` [W] | Title, times, attendee emails and names | Briefs, summaries | Calendar connectors | Until the workspace is deleted. |
| `Extraction`, `Promise` [W] | Labels the AI read from messages, notes and transcripts, each with a verbatim quote and the AI run that made it; promises with owner, date, quote | Signals, promise tracking (D-75) | Watcher and Promise Keeper agents; people | Until the workspace is deleted. |

### 3.7 Work, notes and documents

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Task`, `Note`, `NoteTemplate`, `Notification` [W] | Task text, note bodies (may name customers' staff), mentions | Daily work | The user, agents (marked as AI origin) | Until the workspace is deleted. |
| `MissingDataPrompt`, `DataQualityIssue`, `TodayItem` [W] | Questions about missing fields; data-quality findings; each member's ranked Today list (a cache; rebuilt) | Data quality; Today | System | `TodayItem` rows for a member are deleted and rebuilt on each Today rebuild (`src/modules/today/service.ts`). Others: until the workspace is deleted. |
| `Goal`, `SuccessPlan`, `Document` [W] | Customer goals, success plans, generated briefs and QBRs (metrics and narrative with citations) | Planning, meetings | The user, agents | Until the workspace is deleted. |

### 3.8 Health and signals

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `HealthModel`, `HealthScoreSnapshot`, `HealthReason` [W] | Weights; scores per account per day; reasons with source record ids | Health with proof (Rule 1) | System (deterministic code) | Immutable history. Until the workspace is deleted. |
| `CsmPulse`, `SignalRule`, `Signal`, `OutcomeRecord`, `ReportSnapshot` [W] | CSM judgement; rules; signals with evidence; 7/30/90-day outcomes; weekly report numbers | Signals, outcomes, reports | System, members | Until the workspace is deleted. |

### 3.9 AI and approvals

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `AgentDefinition`, `AgentRun` [W] | Per run: agent, prompt version, model, input record ids, structured output, reasoning summary, citations, tokens, errors | Audit of everything AI does (Rule 5) | System | Until the workspace is deleted. |
| `Approval`, `DraftRevision`, `VoiceSample` [W] | Drafted email text and edits, who approved; approved emails kept as voice samples | Approval before contact (Rule 3); company voice | Agents, members | Until the workspace is deleted. |

### 3.10 Customer contact (outbound)

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `OutboundMessage` [W] | Recipient email, subject, body, guard results, provider message id | The only record of what was sent or held | Approved sends | Until the workspace is deleted. |
| `EmailSuppression` [W] | Suppressed email addresses | Never email these addresses | Bounces, unsubscribes | Until the workspace is deleted. |
| `Campaign`, `CampaignRecipient` [W] | Recipients and delivery events (sent, delivered, opened, clicked, bounced, unsubscribed times) | Campaigns | Members; email-provider webhooks | Until the workspace is deleted. |
| `Play`, `PlayVersion`, `PlayRun`, `PlayStepRun` [W] | Play definitions and run records | Automations | Members, wizard, Play Builder agent | Until the workspace is deleted. |

### 3.11 Onboarding

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `OnboardingTemplate`, `OnboardingPlan`, `OnboardingStep` [W] | Steps, due dates, proof of completion | Onboarding | Members, agents | Until the workspace is deleted. |

### 3.12 Integrations, imports and files

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Integration` [W] | Provider connection: **encrypted credentials** (`credentialsEnc`, AES-256-GCM via `src/lib/crypto`, key from `FIELD_ENCRYPTION_KEY`), scopes, write-back switch and fields, last sync, Usage API key **hash** and last 4 characters only | Connectors | Admin | Until the workspace is deleted, or the Admin disconnects. Never exported. |
| `SyncJob`, `WebhookEvent` [W] | Sync status; webhook metadata (event id and type) and a pointer to the stored raw payload in object storage | Sync history; webhook processing | Providers | Until the workspace is deleted. |
| `SlackUserLink` [W] | Slack user id, linked member, email | Slack approvals | Slack | Deleted when Slack is disconnected (`src/modules/integrations/slack/service.ts`), else until the workspace is deleted. |
| `ImportJob`, `FileObject` [W] | Import status; file name, type, size, hash, storage key | CSV import; uploaded contracts and transcripts | Members | Until the workspace is deleted. The files are in object storage under `ws/<workspaceId>/`. |

### 3.13 Surveys and the customer portal

| Models | Data held | Purpose | Source | Retention |
|---|---|---|---|---|
| `Survey`, `SurveyResponse` [W] | Survey definition; each response: contact, score, free-text comment, one-time link token | NPS/CSAT; sentiment | The customer's contact, through a public link | Survey links are valid for 30 days (`SURVEY_LINK_DAYS`, `src/modules/surveys/service.ts`). Responses: until the workspace is deleted. The token is never exported. |
| `PortalAccess` [W] | Token hash, account, contact, expiry, last use, revoked time | Customer portal magic links | Members issue links | Default expiry 14 days when none is given (`src/modules/portal/service.ts`). The row stays until the workspace is deleted. |

## 4. Other expiries found in code

| Item | Expiry | Source |
|---|---|---|
| Sign-in session | 30 days | `src/lib/auth/config.ts` |
| Invitation link | 7 days | `src/modules/settings/service.ts` |
| Data export download link | 7 days | `EXPORT_LINK_TTL_SECONDS`, `src/modules/settings/data-controls/export.ts` |
| Survey link | 30 days | `src/modules/surveys/service.ts` |
| Portal link | 14 days by default | `src/modules/portal/service.ts` |
| OAuth connect state | 10 minutes | `src/modules/integrations/oauth.ts` |
| Usage API events older than 35 days | Rejected on receipt | `src/modules/integrations/usage-api/receive.ts` |

`Workspace.dataRetentionDays` exists in the schema, and no code reads it (searched `src`). It does
not change any retention today.

## 5. Export and deletion

**Export (D-180).** An Admin can request one ZIP of all [W] data: a JSON file per kind of record,
the uploaded files, and `manifest.json` listing counts and what was left out. The link works for 7
days. Each export is audited. Never exported: integration credentials, Usage API key hash and
last 4, invitation and portal token hashes, survey tokens, passwords, sessions. Contract terms and
pricing notes are exported decrypted (they are the customer's own data). Sources:
`src/modules/settings/data-controls/export.ts`, `export-columns.ts`.

**Deletion (D-179, Q-10).** An Admin types the workspace name. The request starts a 7-day grace
period (`DELETION_GRACE_DAYS`, `src/modules/settings/data-controls/purge.ts`) in which it can be
cancelled. After it, the hourly purge job deletes the stored files under `ws/<id>/`, then the
workspace's audit rows and the `Workspace` row, whose cascade removes every other [W] row. A
`WorkspaceTombstone` is kept with counts. The Settings page states the Q-10 wording: deleted within
30 days of the request; copies in backups expire with the 35-day backup retention
(`src/app/(app)/settings/data/delete-section.tsx`). Whether the deployed backups really expire in 35
days is an operations setting: Not verified here.

The only other `deleteMany` calls outside purge: rebuild of `TodayItem`, removal of
`SlackUserLink` on Slack disconnect, Slack-related notifications, data-quality contact merges
(`src/modules/accounts/data-quality-service.ts`), and stale `RevenueEvent` rows on a billing
re-sync (`src/modules/billing/service.ts`).

## 6. Subprocessors and integrations

### Subprocessors (they receive data from the product)

| Party | What for | What is sent | Where in code | Notes |
|---|---|---|---|---|
| Anthropic | AI API calls | The prompt for one agent run or Ask AI question: only that workspace's records the call needs (the "context bundle"). Agents that read text (for example the Watcher) send message, ticket, note or transcript text. | `src/lib/ai/` (`anthropic.ts`); model names and key from env (`ANTHROPIC_API_KEY`, `AI_MODEL_*`) | Rule 8 and D-75: no model produces a health, risk, forecast or money number, and bundles never cross workspaces (test: `src/lib/ai/__tests__/bundle-isolation.int.test.ts`). Logs do not carry AI content (`src/modules/agents/__tests__/ai-logging.int.test.ts`). Vendor terms are summarised in `docs/SECURITY.md`. The account's own terms (ZDR, signed DPA): Not verified. |
| Resend | Email sending | Invitation emails to members; customer emails after approval | `src/lib/email/` (`resendTransport.ts`, `customerTransport.ts`); `RESEND_API_KEY`, `EMAIL_FROM` | Customer email leaves only through `src/modules/outbound/dispatch.ts`. A log-only transport exists for development and is refused in production. |
| Object storage host | Uploaded files, raw webhook payloads, export ZIPs | Files under `ws/<workspaceId>/` | `src/lib/storage/index.ts` (S3-compatible; `S3_*` env names) | Host to be confirmed at deploy. |
| Error tracking (optional) | Crash reports | Error type, repo-relative stack frames, request or job id, route or job name, environment, release. Never the message, bodies, headers, emails or job data. | `ERROR_TRACKING_DSN` (D-184), `src/instrumentation.ts` | Off when the variable is unset. Vendor not chosen (Q-20). |
| Slack, if the customer connects it | Approval notices to the customer's team | Messages to the customer's own Slack workspace. Never to the customer's customers. | `src/modules/integrations/slack/` | Customer-chosen. In production Slack delivery must be live (`SLACK_DELIVERY`). |

### Connected sources (customer-chosen; not our subprocessors)

HubSpot, Salesforce, Stripe, Chargebee, Zendesk, Freshdesk, Gmail, Microsoft Graph (email and
calendar), Google Calendar, Mixpanel, Amplitude, Segment, and any system that posts to the Usage API.
The adapter folder (`src/modules/integrations/adapters/`) also has Fireflies, Gong and Zoom adapters
(call and meeting sources). Not verified: what each of those three reads, or whether they are enabled in the Integrations page.

These are systems the customer already uses and chooses to connect. **We read from them. We are not
sending customer data to them.** Connections are read-only by default (Rule 7). Write-back exists
only where an Admin turns it on for that integration, ticks the fields, and a person approves each
change (`src/modules/integrations/__tests__/writeback.test.ts`). Slack is the one exception in the
other direction: it sends notices to the customer's team (never to customers).


## 7. What is not stored, or not shown

- **Integration credentials** are encrypted at rest (`credentialsEnc`; `src/modules/integrations/credentials.ts`,
  `src/lib/crypto/index.ts`). They are redacted from logs (`src/lib/logger/index.ts`) and never exported.
- **Usage API raw events are not stored** (Q-33, D-23, D-110, D-117). Events are held only in the
  background job until they are folded into daily totals, then the job is removed. After a final
  failed attempt the events are replaced by a count (`src/modules/integrations/usage-api/job.ts`).
  What stays: the three daily-total tables and `UsageIngestBatch` (hash, counts, unmatched group ids,
  skipped days). Not verified: queue retention behaviour on a deployed Redis (checked in code only).
- **The Usage API key** is shown once; only a hash and the last 4 characters are stored.
- **`ProductEvent`** holds ids, a closed event name, and small values only (D-183).
- **Error tracking** never receives message text or content (D-184).
- **Logs**: request and job ids; secrets and emails in free text are redacted
  (`src/lib/__tests__/log-redaction.test.ts`).
- **Message bodies**: the schema has a `Message.bodyStorageKey` column; the code search found no use
  of it. Message text is read from the `bodyText` column. Not verified: whether any path stores
  bodies in object storage.
