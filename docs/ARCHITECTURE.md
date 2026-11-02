# ARCHITECTURE — NexaWorks AI CSM

Status: design, written before any product code (planning session, 2026-10-31).
Source-of-truth order: product spec (`ai-customer-success-manager-complete-product-spec-2026-10-31.md`)
→ this file → `docs/IMPLEMENTATION_PLAN.md` → `CLAUDE.md`. Section references like "§6C2" point to the spec.
Interpretations of the spec are marked **[INTERP-n]** and mirrored in `docs/QUESTIONS.md` / `docs/DECISIONS.md`.

---

## 0. Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | One of *our* customers (a B2B SaaS company). The tenant boundary. Spec calls this "Company". |
| **Account** | One of *their* customers. Everything in the product hangs off an Account. |
| **Tier** | The account type from spec §2: `HIGH_TOUCH`, `MID_TOUCH`, `LONG_TAIL`. |
| **Source record** | Any stored fact that came from outside the AI: usage row, ticket, message, invoice, contact, note, survey response, CSM Pulse. |
| **Proof** | A list of `{sourceType, sourceId}` pointers plus values, dates and a plain-language reason. Every number and AI claim carries one. |
| **AgentRun** | One audited execution of one agent. Every piece of AI text in the product points to exactly one AgentRun. |
| **PRODUCT_NAME** | Single config value (`src/config/product.ts`), working value "NexaWorks AI CSM". Never hard-coded elsewhere. |

---

## 1. System overview

One repository, one Next.js application, one background worker process built from the same codebase.
No microservices.

```
                         ┌──────────────────────────────────────────────────────────┐
  Browser (CSM, Leader,  │                 Next.js app  (src/app)                   │
  Admin, Viewer)  ──────▶│  App Router pages · Server Actions · Route Handlers      │
                         │  (REST for webhooks, Slack interactivity, portal, export)│
  Customer contact ─────▶│  /portal/* (magic-link, read-mostly)                     │
  (Portal)               │                                                          │
                         │   ┌─────────────── src/modules/<domain> ───────────────┐ │
                         │   │ service.ts · schemas.ts · actions/ · __tests__/    │ │
                         │   └────────────────────────────────────────────────────┘ │
                         │   src/lib: auth · db (scoped client) · ai · email ·      │
                         │            storage · jobs · audit · crypto · config      │
                         └───────┬───────────────┬──────────────────┬───────────────┘
                                 │ Prisma        │ enqueue (BullMQ) │ S3 API
                                 ▼               ▼                  ▼
                        ┌──────────────┐  ┌────────────┐   ┌──────────────────┐
                        │ PostgreSQL   │  │   Redis    │   │ Object storage   │
                        │ (RLS on all  │  │ (queues,   │   │ (S3-compatible;  │
                        │ tenant tables)│ │ rate limits)│  │ MinIO locally)   │
                        └──────▲───────┘  └─────┬──────┘   └────────▲─────────┘
                               │                │ consume           │
                         ┌─────┴────────────────▼───────────────────┴──────────┐
                         │          Worker process  (src/worker/index.ts)        │
                         │  queues: sync · signals · health · agents · outbound  │
                         │          outcomes · reports · maintenance             │
                         │  same src/modules + src/lib code as the web app       │
                         └─────┬──────────────────────────────┬─────────────────┘
                               │ adapters (src/modules/        │ src/lib/ai provider
                               │ integrations/adapters/*)      │ (Anthropic SDK)
                               ▼                               ▼
          HubSpot · Salesforce · Stripe · Chargebee ·     Anthropic API
          Zendesk · Freshdesk · Mixpanel · Amplitude ·    (model names from env:
          Segment/Usage API · Google & Microsoft mail +    AI_MODEL_FAST /
          calendar · Slack · Fireflies · Gong · Zoom       AI_MODEL_STANDARD /
          Resend (outbound email, via src/lib/email)        AI_MODEL_DEEP)
```

Local services come from `docker compose up -d postgres redis` (plus `minio` for storage; see QUESTIONS Q-17).
The compose file sets an explicit `name:` because the repo folder name contains spaces.

### 1.1 How a user request flows (example: CSM approves a draft email)

1. Browser submits the Server Action `approveDraft({ approvalId, editedBody? })` (`src/modules/approvals/actions/`).
2. `src/lib/auth.getSession()` resolves the database session → `userId`. No session → 401.
3. `src/lib/auth.getWorkspaceContext()` reads the active workspace from the session and loads the `Membership`
   (role + `canViewRevenue`). No membership → 403. The client never supplies `workspaceId` for authorization.
4. `requirePermission(ctx, "approvals:decide")` checks the RBAC matrix (§7.2). CSMs may decide only on accounts in their book unless granted wider scope.
5. Input is Zod-parsed (`schemas.ts`). Server never trusts client input.
6. `const db = scopedDb(ctx)`: a Prisma client extension that injects `workspaceId` into every query on tenant models
   **and** runs each operation inside a transaction that sets `app.workspace_id` for Postgres RLS (§7.1).
7. `approvals.service.approve()` moves the `Approval` to `APPROVED` and records `decidedById`/`decidedAt`. Then it calls
   `outbound.dispatch(outboundMessageId)`, the **only** code path that can send customer email (§7.4).
8. `dispatch` re-checks the approval, the sensitive-topic flag, suppression and the guards (§7.4). It sends through `src/lib/email`
   (log-only transport in dev, Resend in prod) and records `OutboundMessage.sentAt`.
9. `audit.write()` appends an `AuditLog` row (actor, action, target ids, before/after hash). The `OutcomeRecord`
   for the originating signal moves to `actionTaken = ACTED`.
10. `revalidatePath` refreshes Approvals and Account 360. The response returns typed data, never raw Prisma errors.

### 1.2 How a nightly signal run flows

1. **Scheduler.** For each active workspace, a BullMQ repeatable job `nightly.kickoff` fires at 02:00 in the workspace's time zone.
2. **Sync.** `kickoff` enqueues `sync.run` for each connected integration (incremental, cursor-based; §5). The next steps wait on those jobs through a BullMQ flow (parent job).
3. **Fan-out.** `kickoff` lists the workspace's active account ids in pages of 200 and enqueues one `signals.evaluateChunk` job per page.
4. **Evaluate.** Each chunk job:
   a. bulk-loads the chunk's inputs with set-based queries (no per-account N+1): usage aggregates over `UsageDaily`, open tickets, invoices, contracts, contacts, latest `Extraction`s and baselines;
   b. runs every enabled `SignalRule` evaluator, a pure function, over that in-memory bundle;
   c. upserts `Signal`s by `dedupeKey` (idempotent re-runs) and resolves signals whose condition has cleared;
   d. enqueues `health.scoreChunk` for the same ids.
5. **Score.** `health.scoreChunk` computes a `HealthScoreSnapshot` (6 pillars + overall + `HealthReason`s) with the workspace's active `HealthModel` version. It writes each snapshot in its own transaction.
6. **Trigger agents and plays.** New or changed signals emit domain events (`signal.opened`, `health.bandChanged`), stored in an outbox table and then enqueued. Those events trigger:
   - **Health Analyst** `AgentRun`s, only for accounts whose band or top reasons changed (cost control);
   - **play triggers** (M8).
7. **Prepare tomorrow.** The `today.rebuild` job recomputes each user's ranked Today queue (§9) and caches it in the `TodayItem` table.
8. **Outcomes.** The `outcomes.checkpoint` job evaluates every `OutcomeRecord` that has reached its 7/30/90-day checkpoint (§3.6).

Every job is idempotent: keys are deterministic (`workspaceId:job:date:chunk`), and writes are upserts on unique keys.
A failed chunk retries with exponential backoff and does not block the other chunks. After 3 failures a job lands in
the `maintenance.deadLetter` list, which the Settings › Data health page shows in plain words.

### 1.3 How an agent run flows (example: Renewal Manager, 90 days out)

1. **Trigger.** Signal `RENEWAL_WINDOW_90` opens → event → `agents.enqueue({ agentKey: "renewal-manager", trigger: { type: "signal", id } })`.
2. **Idempotency key.** `idempotencyKey = sha256(workspaceId, agentKey, agentVersion, triggerType, triggerId, inputHash)`.
   An `AgentRun` row is inserted with status `QUEUED` under a unique constraint on that key.
   If a row already exists, the enqueue is a no-op, which makes retries and duplicate events safe.
3. **Build context.** The worker calls the agent's `buildContext()`. It loads only scoped records and returns a
   **ContextBundle**: a list of `{ sourceType, sourceId, fields }`. The bundle's ids are persisted to `AgentRun.inputRefs`.
4. **Render prompt.** The worker loads `prompts/renewal-manager.md` (frontmatter `name`, `version`) and renders it with the bundle.
   The model name comes from the env var for the agent's tier.
5. **Call the model.** `src/lib/ai` calls the Anthropic SDK and requests structured output with the Messages API's `output_config.format`, built from the agent's Zod `outputSchema` (`messages.parse` + `zodOutputFormat`; D-35; forced `tool_choice` is rejected by current models).
   Requests carry no customer data beyond this workspace's bundle (Rule 8), and the request id is logged (never the content).
6. **Validate.**
   a. Zod-parse the output. On failure, run one repair call; if that also fails, set `AgentRun.status = INVALID_OUTPUT` and render nothing.
   b. **Citation check:** every `citations[].sourceId` must exist in the ContextBundle, and every `quote` must be a verbatim substring of the cited record's text. On failure, set status `UNCITED` and render nothing (Rules 1, 4).
   c. **Number check:** any numeric field the agent is not allowed to originate is overwritten from deterministic code before saving, as listed in its definition. Agents never output money or scores; §3.3.
7. **Persist.** Save the output, reasoning summary, confidence and token usage. Status becomes `SUCCEEDED`.
8. **Act by policy.** For each proposed action (draft email, create task, update field), the action's approval level decides what happens (§7.3):
   create an `Approval` (with linked `OutboundMessage` for emails), execute an internal-only safe action, or notify.
   `AgentRun.actionTaken` records what happened.
9. **Audit and ledger.** The run writes an `AuditLog` row. If the run flagged risk or opportunity, it creates or updates an `OutcomeRecord`.

---

## 2. Domain module map

Each module lives in `src/modules/<name>/` with `service.ts`, `schemas.ts`, `actions/` (Server Actions) or `api/`
(Route Handlers), `__tests__/`, and optionally `jobs.ts` (worker handlers), `rules/`, `ui/` (module-specific components).
Modules call each other only through `service.ts` exports, never through each other's Prisma queries. Events
go through the outbox (`src/lib/jobs/outbox.ts`).

| Module | Responsibilities | Owns records | Emits events | Milestone |
|---|---|---|---|---|
| `accounts` | Account Graph, list, inline edit, tiering, timeline assembly, missing-data helper, data-quality checker, CSV import of accounts | Account, DataQualityIssue, MissingDataPrompt, ExternalRef (shared w/ integrations) | `account.created`, `account.updated`, `account.ownerChanged` | M2 |
| `contacts` | People & stakeholder map, champion designation, relationship health inputs | Contact, StakeholderRole | `contact.roleChanged`, `contact.bounced`, `contact.left` | M2 |
| `billing` | Contracts, subscriptions, invoices, seats/credits bought, notice periods, field-level protection | Contract, Subscription, Invoice | `invoice.failed`, `invoice.paid`, `contract.renewalDateSet` | M2 |
| `usage` | Daily usage per account and per user, feature usage, baselines, cohort definitions | UsageDaily, UserUsageDaily, FeatureUsageDaily, UsageBaseline | `usage.ingested` | M2 (CSV), M6 (live) |
| `support` | Tickets, ticket messages, SLA age, repeat detection input | Ticket (+ ticket Messages via Conversation) | `ticket.opened`, `ticket.escalated` | M2 (CSV), M9 (live) |
| `conversations` | Calls, emails, chats as Conversations + Messages; CallTranscripts; LLM text extraction; sentiment & themes | Conversation, Message, CallTranscript, Extraction | `message.received`, `extraction.created` | M9 |
| `health` | Deterministic 6-pillar scoring, baselines/cohorts, model versions, proposal + back-test, CSM Pulse, Health screen | HealthModel, HealthScoreSnapshot, HealthReason, CsmPulse | `health.bandChanged` | M3 |
| `signals` | Signal library (rules), evaluation, dedupe, lifecycle, false-alarm marking, outside signals | SignalRule, Signal | `signal.opened`, `signal.resolved` | M3 |
| `agents` | Agent registry, executor, context bundles, citation/number validation, agent pages (what it read/decided/did, accuracy) | AgentDefinition, AgentRun | `agentRun.succeeded` | M4 |
| `approvals` | Approvals queue, approve/edit/reject, approval levels, Slack approve callback | Approval | `approval.decided` | M4 |
| `outbound` | The single customer-send path, auto-send guards, sensitive-topic gate, suppression, pacing, delivery webhooks | OutboundMessage, EmailSuppression | `outbound.sent`, `outbound.bounced` | M4 (approved sends), M8 (auto-send) |
| `tasks` | Tasks from plays/agents/humans, due dates, overdue escalation | Task | `task.overdue`, `task.completed` | M2 (manual), M4 (escalation) |
| `notes` | Notes on accounts/meetings, templates per call type, tags, @mentions, play trigger | Note, NoteTemplate | `note.created` | M2 |
| `segments` | Filter-based segments (stage, plan, health, industry, owner, any field) | Segment | `segment.membershipChanged` | M2 |
| `today` | Ranked Today queue per user (deterministic ranking) | TodayItem (cache) | — | M4 |
| `onboarding` | Onboarding plans/steps, time-to-value, stalls, Sales handoff assembly, adoption view | OnboardingPlan, OnboardingStep, OnboardingTemplate | `onboarding.stalled`, `onboarding.valueReached` | M6 |
| `renewals` | Renewal Radar, deterministic confidence, Renewal Brief, renewal plans | Renewal | `renewal.windowEntered` | M7 |
| `expansion` | Expansion opportunities, estimates (labelled), CRM export | ExpansionOpportunity | `expansion.created` | M7 |
| `revenue` | ARR waterfall, invoice-level billing forecast, money at risk, revenue events | RevenueEvent | — | M7 |
| `promises` | Promise Tracker: extracted + manual promises, owner, due, late chasing | Promise | `promise.late` | M9 |
| `plays` | Play definitions (15 seeded), builder, safety check, runner, step handlers, play results, NL → draft play | Play, PlayVersion, PlayRun, PlayStepRun | `playRun.started`, `playStep.completed` | M8 |
| `campaigns` | Segment campaigns: editor, schedule, pacing, delivered/open/click/bounce, unsubscribe | Campaign, CampaignRecipient | — | M8 |
| `inbox` | Customer email/ticket items in account context, intent + sentiment, drafted replies | InboxItem | `inbox.itemCreated` | M9 |
| `meetings` | Meetings from calendars, pre-call briefs, call summaries, action items | Meeting, MeetingAttendee | `meeting.ended` | M10 |
| `success-plans` | Success plans, goals, shared documents/reviews (QBR) with locked computed metrics | SuccessPlan, Goal, Document | — | M10 |
| `surveys` | NPS/CSAT/CES definitions, sends at journey moments, responses feeding health | Survey, SurveyResponse | `survey.responded` | M10 |
| `portal` | Customer-facing view (plan, goals, progress, documents, reviews), magic-link access | PortalAccess | — | M10 |
| `outcomes` | Outcome ledger, 7/30/90-day checkpoints, save record, AI accuracy | OutcomeRecord | — | M4 (records), M11 (views) |
| `reports` | Pre-made leader reports, weekly Leader Reporter digest | ReportSnapshot, ProductEvent (M12) | — | M11 |
| `ask-ai` | Copilot: tool-using Q&A over scoped data, file upload Q&A, confirmed actions | AskThread, AskMessage | — | M11 |
| `integrations` | Adapter framework, OAuth, sync jobs, webhooks, write-back gate, setup wizard | Integration, SyncJob, WebhookEvent, ExternalRef | `sync.completed` | M5 (+ adapters in M6/M9/M10) |
| `settings` | Workspace settings, users & invitations, roles, approval rules, data controls, export/delete | Workspace, Membership, Invitation, WorkspaceSettings | — | M1 |
| `audit` | Audit viewer + export (the write primitive lives in `src/lib/audit`) | AuditLog | — | M1 (write), M4 (viewer/export) |

Cross-cutting libraries (`src/lib/`): `auth`, `db` (scoped client, RLS), `ai` (provider, prompt loader, tiers),
`email` (transports), `storage` (S3 + upload safety), `jobs` (queues, outbox, scheduler), `audit`, `crypto`
(field encryption), `config` (PRODUCT_NAME, pricing, env schema), `money` (integer minor units + currency).

---

## 3. Data model

### 3.1 Conventions (apply to every entity unless stated)

- `id String @id @default(cuid())`, `createdAt`, `updatedAt`.
- **[W] = workspace-scoped.** It has `workspaceId String` (NOT NULL), `@@unique([workspaceId, id])`, and **composite foreign keys**
  `(workspaceId, parentId) → Parent(workspaceId, id)`. A child row therefore cannot point at a parent in another workspace,
  which makes cross-tenant references impossible by construction. Postgres RLS policy: `workspace_id = current_setting('app.workspace_id')`.
- **[G] = global** (no workspaceId). Only auth/identity tables and the job outbox are global.
- Money is stored as `BigInt` minor units plus a `currency` (ISO 4217). Workspace has a `baseCurrency` (Q-12).
- Every external record has `source` (`CSV | HUBSPOT | SALESFORCE | STRIPE | … | MANUAL | SEED`) and maps to `ExternalRef`.
- Every AI-originated row has `origin` (`HUMAN | SYSTEM | AI | IMPORT`) and `agentRunId`, plus a DB CHECK:
  `origin <> 'AI' OR agent_run_id IS NOT NULL`. This is Rule 5, "no orphan AI text", enforced by the database.
- Soft delete is not used for tenant data. Deletion is explicit (§7.7). Records carry `archivedAt` where archiving is a product concept.
- Index rule: every [W] table's hot indexes start with `workspaceId`.

### 3.2 Entities

**Identity & tenancy**

| Entity | Scope | Key fields | Relations | Indexes / constraints |
|---|---|---|---|---|
| Workspace | root | name, slug, timezone, baseCurrency, status, dataRetentionDays, deletionRequestedAt | has many Membership, everything [W] | unique slug |
| User | G | email, name, image, passwordHash? (credentials), emailVerified | Membership, AuthAccount, Session | unique email |
| AuthAccount | G | Auth.js OAuth link (provider, providerAccountId, tokens encrypted) | User | unique (provider, providerAccountId). Named `AuthAccount` to avoid colliding with our `Account` (DECISIONS D-08) |
| Session | G | sessionToken, userId, expires, activeWorkspaceId | User | unique sessionToken |
| VerificationToken | G | identifier, token, expires | — | unique (identifier, token) |
| Membership (Role) | W | userId, role (`ADMIN | CS_LEADER | CSM | VIEWER`), canViewRevenue (bool), bookScope (`OWN | TEAM | ALL`), status | User, Workspace | unique (workspaceId, userId) |
| Invitation | W | email, role, canViewRevenue, tokenHash, expiresAt, acceptedAt | Workspace | unique tokenHash |
| WorkspaceSettings | W | 1:1; Zod-typed JSON: tier thresholds, quiet hours, auto-send master switch, signal params, export/delete policy | Workspace | unique workspaceId |

**Accounts & people**

| Entity | Scope | Key fields | Relations | Indexes |
|---|---|---|---|---|
| Account | W | name, domain, tier (`HIGH_TOUCH | MID_TOUCH | LONG_TAIL`), tierSource (`RULE | MANUAL`), lifecycleStage (`ONBOARDING | ADOPTING | MATURE | RENEWING | LOST`), ownerId?, plan, industry, employeeBand, useCase, timezone?, arrMinor (derived, see Contract), currentHealthSnapshotId?, lastTouchAt, source | Contact, Contract, Ticket, Conversation, Signal, … | (workspaceId, ownerId), (workspaceId, tier), (workspaceId, lifecycleStage), (workspaceId, lower(name)), (workspaceId, domain) |
| Contact | W | accountId, name, email, title, timezone?, status (`ACTIVE | BOUNCED | LEFT | UNKNOWN`), lastContactAt, emailEngagementScore? (deterministic) | Account, StakeholderRole, Message | (workspaceId, accountId), (workspaceId, lower(email)) |
| StakeholderRole | W | contactId, accountId, role (`CHAMPION | DECISION_MAKER | DAILY_USER | EXEC_SPONSOR | BILLING | OTHER`), validFrom, validTo?, setBy (userId or agentRunId), origin | Contact | (workspaceId, accountId, role, validTo). History kept for point-in-time back-tests |
| Segment | W | name, filter (Zod-validated JSON DSL), isDynamic, createdById | — | (workspaceId, name) |
| Note | W | accountId, meetingId?, authorId, templateId?, body, tags[], mentions[] (userIds) | Account, Meeting | (workspaceId, accountId, createdAt) |
| NoteTemplate | W | name, callType, body | — | — |
| DataQualityIssue | W | accountId?, contactId?, kind (`DUPLICATE | STALE | INVALID | CONFLICT`), detail, suggestedFix (JSON), status (`OPEN | FIXED | DISMISSED`), fixedById | — | (workspaceId, status) |
| MissingDataPrompt | W | accountId, field (`RENEWAL_DATE | OWNER | KEY_CONTACT | CONTRACT_VALUE`), askedUserId, askedAt, answeredAt?, skippedAt?, snoozeUntil | — | unique (workspaceId, accountId, field). One open prompt per field; skip snoozes 30d (Q-09) |

**Commercial**

| Entity | Scope | Key fields | Relations | Indexes |
|---|---|---|---|---|
| Contract | W | accountId, startDate, endDate?, renewalDate?, autoRenew?, noticePeriodDays?, valueMinor?, currency, seatsPurchased?, creditsPurchased?, termsEnc (encrypted text), pricingNotesEnc (encrypted), status, documentFileId? | Account, Subscription, FileObject | (workspaceId, accountId), (workspaceId, renewalDate) |
| Subscription | W | accountId, contractId?, externalId, plan, interval, amountMinor, currency, status, currentPeriodEnd, quantity | Contract, Invoice | (workspaceId, accountId) |
| Invoice | W | accountId, subscriptionId?, number, amountMinor, currency, issuedAt, dueAt, paidAt?, status (`OPEN | PAID | FAILED | VOID | UNCOLLECTIBLE`), failureCount | Subscription | (workspaceId, status, dueAt), (workspaceId, accountId, issuedAt) |
| RevenueEvent | W | accountId, type (`NEW | EXPANSION | CONTRACTION | CHURN | REACTIVATION`), deltaArrMinor, currency, effectiveDate, sourceType, sourceId (contract/subscription/invoice), computedBy (`RULE`) | Account | (workspaceId, effectiveDate), (workspaceId, accountId) |

**Usage**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| UsageDaily | W | accountId, date, activeUsers, sessions, events, seatsUsed?, creditsUsed?, source | unique (workspaceId, accountId, date) |
| UserUsageDaily | W | accountId, contactId? / externalUserId, date, events, sessions, isPowerUser (derived) | unique (workspaceId, accountId, externalUserId, date) |
| FeatureUsageDaily | W | accountId, featureKey, date, users, events | unique (workspaceId, accountId, featureKey, date) |
| FeatureCatalog | W | featureKey, label, isKeyFeature, includedInPlans[] | unique (workspaceId, featureKey) |
| UsageBaseline | W | accountId, metric, windowEnd, accountMedian?, accountP25?, cohortKey, cohortMedian?, cohortSize, computedAt | unique (workspaceId, accountId, metric, windowEnd) |

**Support & conversations**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| Ticket | W | accountId, contactId?, externalId, subject, status, priority (`LOW | NORMAL | HIGH | URGENT`), isEscalated, openedAt, firstResponseAt?, closedAt?, conversationId, source | (workspaceId, accountId, status), (workspaceId, openedAt) |
| Conversation | W | accountId, channel (`EMAIL | CALL | CHAT | TICKET | MEETING`), subject, startedAt, lastMessageAt, externalThreadId | (workspaceId, accountId, lastMessageAt) |
| Message | W | conversationId, accountId, direction (`INBOUND | OUTBOUND`), fromContactId?, fromUserId?, sentAt, subject, bodyText, bodyStorageKey? (large), sentimentLabel?, sentimentAgentRunId? | (workspaceId, accountId, sentAt) |
| CallTranscript | W | meetingId?, conversationId, accountId, provider, language, text (or storageKey), segments (JSON speaker/time), durationSec | (workspaceId, accountId) |
| Extraction | W | sourceType (`MESSAGE | TICKET | CALL_TRANSCRIPT | NOTE | SURVEY_RESPONSE | FILE`), sourceId, accountId, kind (`SENTIMENT | COMPETITOR | BUDGET_CONCERN | PROMISE | GOAL | CANCEL_LANGUAGE | EXPORT_LANGUAGE | COMPLAINT | RENEWAL_CONCERN | ACTION_ITEM | DECISION | THEME | INTENT`), payload (Zod per kind), quote (verbatim, validated), confidence, agentRunId (NOT NULL), origin=AI | (workspaceId, accountId, kind, createdAt), (workspaceId, sourceType, sourceId) |

**Health & signals**

| Entity | Scope | Key fields | Indexes / constraints |
|---|---|---|---|
| HealthModel | W | version (int), status (`DRAFT | ACTIVE | RETIRED`), pillarWeights (6 numbers), componentConfig (JSON, Zod), thresholds {healthyMin, watchMin}, perTierOverrides, proposedBy (`SYSTEM_DEFAULT | BACKTEST_PROPOSAL | HUMAN`), backtestResult (JSON, see §4.5), approvedById?, activatedAt | unique (workspaceId, version); partial unique: one ACTIVE per workspace |
| HealthScoreSnapshot | W | accountId, healthModelId, asOf (date), overall (0–100, nullable), adoption, engagement, support, relationship, commercial, sentiment (each nullable = "no data", never 0), overallExcludingPulse, riskLevel (`HEALTHY | WATCH | AT_RISK | INSUFFICIENT_DATA`), riskReasonId? (FK HealthReason), pulseDisagreement (bool), inputsHash, isBacktest (bool) | unique (workspaceId, accountId, healthModelId, asOf, isBacktest); CHECK `risk_level <> 'AT_RISK' OR risk_reason_id IS NOT NULL` |
| HealthReason | W | snapshotId, pillar, component, direction (`UP | DOWN | NEUTRAL`), impact (signed points), message (template-rendered plain language), value, baseline?, cohortValue?, periodStart, periodEnd, sources (JSON array `{sourceType, sourceId}` min 1), kind (`EVIDENCE | MISSING_DATA`) | (workspaceId, snapshotId). CHECK `kind = 'MISSING_DATA' OR jsonb_array_length(sources) >= 1` |
| CsmPulse | W | accountId, userId, value (`FINE | WORRIED`), comment?, createdAt, expiresAt | (workspaceId, accountId, createdAt) |
| SignalRule | W | ruleKey (from code library), category (`USAGE | PEOPLE | SUPPORT | CALLS_EMAIL | MONEY | PROMISES | OUTSIDE`), enabled, params (Zod per rule), severity, meaning, howDetected, typicalLeadTime, falseAlarmCauses (the four spec §6D fields, seeded from code, editable) | unique (workspaceId, ruleKey) |
| Signal | W | accountId, ruleKey, category, severity (`INFO | WARN | CRITICAL`), polarity (`RISK | OPPORTUNITY`), status (`OPEN | ACKNOWLEDGED | RESOLVED | FALSE_ALARM`), title, explanation (template-rendered), evidence (JSON `{sourceType, sourceId, value, date}[]` min 1), dedupeKey, firstSeenAt, lastSeenAt, resolvedAt?, markedFalseById?, origin (`SYSTEM | AI`), agentRunId? (required when origin=AI), publicSourceUrl?, publicSourceDate? (required for OUTSIDE) | unique (workspaceId, dedupeKey); (workspaceId, status, severity); (workspaceId, accountId, firstSeenAt). CHECK evidence non-empty; CHECK OUTSIDE ⇒ source url + date |

**AI & approvals**

| Entity | Scope | Key fields | Indexes / constraints |
|---|---|---|---|
| AgentDefinition | W | agentKey, codeVersion, enabled, approvalPolicyOverrides (JSON per tier), modelTierOverride? (within allowed set), isCustom (false; Phase 2 seam) | unique (workspaceId, agentKey) |
| AgentRun | W | agentKey, agentVersion, promptName, promptVersion, model, modelTier, trigger {type, id}, idempotencyKey, inputRefs (JSON `{sourceType, sourceId}[]`), status (`QUEUED | RUNNING | SUCCEEDED | INVALID_OUTPUT | UNCITED | FAILED | SKIPPED`), output (JSON, validated), reasoningSummary, confidence (0–1), citations (JSON), actionTaken (`NONE | DRAFTED | APPROVAL_REQUESTED | TASK_CREATED | NOTIFIED | EXECUTED | SENT`), approvalId?, inputTokens, outputTokens, latencyMs, errorCode?, startedAt, finishedAt | unique (workspaceId, idempotencyKey); (workspaceId, agentKey, createdAt); (workspaceId, status). CHECK status='SUCCEEDED' ⇒ output, reasoningSummary, confidence, promptVersion, model NOT NULL |
| Approval | W | accountId, kind (`SEND_EMAIL | CREATE_TASK | UPDATE_FIELD | ENROLL_PLAY | BULK_ACTION | WRITE_BACK`), payload (JSON), proposedByAgentRunId?, proposedByUserId?, reason, proof (JSON sources min 1 when AI), status (`PENDING | APPROVED | EDITED_APPROVED | REJECTED | EXPIRED | SUPERSEDED`), decidedById?, decidedAt?, decisionNote?, editDiff?, requiredLevel, isSensitive, sensitiveReasons[], assigneeId | (workspaceId, status, assigneeId); (workspaceId, accountId) |
| OutboundMessage | W | accountId, contactId, conversationId?, approvalId?, playStepRunId?, campaignId?, subject, bodyText, bodyHtml?, status (`DRAFT | AWAITING_APPROVAL | QUEUED | HELD | SENT | FAILED | BOUNCED | CANCELLED`), heldReason?, sendMode (`APPROVED | AUTO`), guardResults (JSON), sentAt?, providerMessageId?, origin, agentRunId? | (workspaceId, contactId, sentAt); (workspaceId, accountId, sentAt) — guard lookups |
| EmailSuppression | W | email, reason (`UNSUBSCRIBED | BOUNCED | COMPLAINED | MANUAL`), createdAt | unique (workspaceId, lower(email)) |
| VoiceSample | W | userId, outboundMessageId or messageId (real sent examples), approvedForVoice (bool) | Used only as in-prompt examples for this workspace (Rule 8) |

**Work**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| Task | W | accountId?, title, detail, ownerId, dueAt?, status (`OPEN | DONE | CANCELLED`), priority, origin, createdByUserId?, agentRunId?, playStepRunId?, escalatedAt?, completedAt? | (workspaceId, ownerId, status, dueAt) |
| TodayItem | W | userId, itemType (`TASK | SIGNAL | MEETING | APPROVAL | RENEWAL`), refId, accountId, rankScore, rankReasons (JSON), computedAt | (workspaceId, userId, rankScore desc). Rebuildable cache |
| Notification | W | userId, type, refType, refId, channel (`IN_APP | SLACK | EMAIL`), readAt? | (workspaceId, userId, readAt) |

**Onboarding, renewals, expansion, promises, plans**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| OnboardingTemplate | W | name, forTier?, forPlan?, steps (JSON), valueDefinition (JSON: measurable "value reached" criteria) | — |
| OnboardingPlan | W | accountId, templateId?, startDate, targetValueDate, valueReachedAt?, status (`ACTIVE | STALLED | COMPLETE | CANCELLED`), stallReason?, handoff (JSON assembled from sales data, each item with sources) | unique (workspaceId, accountId) active |
| OnboardingStep | W | planId, title, ownerSide (`US | CUSTOMER`), ownerUserId?, ownerContactId?, dueDate, doneAt?, blockedReason? | (workspaceId, planId) |
| Renewal | W | accountId, contractId, renewalDate, noticeDeadline?, arrAtRiskMinor, confidence (0–100, deterministic), confidenceBand, confidenceReasons (JSON with sources), stage (`UPCOMING | IN_PLAN | NEGOTIATING | RENEWED | CHURNED | CONTRACTED | EXPANDED`), planSteps (JSON), briefDocumentId?, outcomeArrMinor? | (workspaceId, renewalDate), unique (workspaceId, contractId, renewalDate) |
| ExpansionOpportunity | W | accountId, source (signal ids), estimateMinor, estimateMethod (string, rule id), isEstimate (always true until closed), ownerId, nextStep, nextStepDate, status (`OPEN | WON | LOST | DISMISSED`), crmExternalId? | (workspaceId, status) |
| Promise | W | accountId, text, madeAt, dueDate?, ownerId?, status (`OPEN | DONE | LATE | CANCELLED`), sourceType, sourceId, quote, origin, agentRunId?, chasedAt? | (workspaceId, status, dueDate) |
| Goal | W | accountId, successPlanId?, text, metricKey?, targetValue?, status, sourceType?, sourceId?, quote?, origin, agentRunId? | (workspaceId, accountId) |
| SuccessPlan | W | accountId, title, status, sharedWithPortal (bool), objectives (Goal relation), milestones (JSON) | (workspaceId, accountId) |
| Document (Review/QBR) | W | accountId, kind (`QBR | RENEWAL_BRIEF | PRE_CALL_BRIEF | SUCCESS_PLAN_EXPORT | UPLOADED`), periodStart?, periodEnd?, metrics (JSON computed snapshot, **locked**), narrative (JSON blocks; editable; numbers only via `{{metric.key}}` placeholders), status (`DRAFT | FINAL | SHARED`), agentRunId?, origin, fileObjectId? | (workspaceId, accountId, kind) |
| Meeting | W | accountId?, externalId, title, startsAt, endsAt, organizerUserId, conversationId?, briefDocumentId?, summaryAgentRunId?, source | (workspaceId, startsAt) |
| MeetingAttendee | W | meetingId, contactId?, userId?, email, responseStatus | (workspaceId, meetingId) |

**Plays, campaigns, surveys**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| Play | W | key (seeded key or custom slug), name, category, status (`DRAFT | PUBLISHED | PAUSED | KILLED`), currentVersionId, isSeeded | unique (workspaceId, key) |
| PlayVersion | W | playId, version, definition (Zod `PlayDefinition`: trigger, conditions, branches, steps with handler + approval level per tier), safetyCheck (JSON result), publishedById?, publishedAt? | unique (workspaceId, playId, version) |
| PlayRun | W | playVersionId, accountId, triggerRef, status (`RUNNING | WAITING | COMPLETED | EXITED | FAILED`), enteredAt, exitedAt?, exitReason? | unique (workspaceId, playVersionId, accountId, triggerRef) — idempotent entry |
| PlayStepRun | W | playRunId, stepKey, handler, status (`PENDING | WAITING_APPROVAL | DONE | SKIPPED | FAILED`), approvalId?, taskId?, outboundMessageId?, agentRunId?, scheduledFor?, result | (workspaceId, status, scheduledFor) |
| Campaign | W | name, segmentId, subject, body, status (`DRAFT | SCHEDULED | SENDING | SENT | CANCELLED`), scheduledAt?, pacePerHour, approvalId (campaigns always need one approval) | — |
| CampaignRecipient | W | campaignId, contactId, outboundMessageId?, status, deliveredAt?, openedAt?, clickedAt?, bouncedAt?, unsubscribedAt? | unique (workspaceId, campaignId, contactId) |
| Survey | W | type (`NPS | CSAT | CES`), trigger (journey moment), question, status | — |
| SurveyResponse | W | surveyId, accountId, contactId?, score, comment?, respondedAt | (workspaceId, accountId, respondedAt) |

**Outcomes, reports, Ask AI, portal**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| OutcomeRecord | W | accountId, signalId?, agentRunId?, flagType (`RISK | OPPORTUNITY`), flaggedAt, arrAtFlagMinor, actionTaken (`ACTED | IGNORED | PENDING`), actionRefs (JSON: approval/task/outbound/playRun ids), firstActionAt?, d7Outcome?, d30Outcome?, d90Outcome? (each `{status: REPLIED | MEETING_HELD | RECOVERED | RENEWED | EXPANDED | CONTRACTED | CHURNED | NO_CHANGE, evidence: sources[] , evaluatedAt}`), valueSavedMinor?, valueExpandedMinor?, isTrueAlarm? (derived), csmAgreed? | (workspaceId, flaggedAt); unique (workspaceId, signalId) |
| ReportSnapshot | W | reportKey, period, data (JSON computed), generatedAt, digestAgentRunId? | (workspaceId, reportKey, period) |
| ProductEvent | W | userId, name (`TODAY_OPENED | APPROVALS_OPENED | FLAG_ACCEPTED | FLAG_REJECTED | BRIEF_GENERATED | BRIEF_SHARED | …`), refType?, refId?, occurredAt. Internal product instrumentation for spec §11 pilot metrics; never sent to third parties | (workspaceId, name, occurredAt) |
| InboxItem | W | accountId? (null = Unmatched queue), sourceType (`MESSAGE | TICKET`), sourceId, status (`NEW | DRAFTED | REPLIED | CLOSED | UNMATCHED`), intent?, sentimentLabel?, intentAgentRunId?, assigneeId?, draftOutboundMessageId?, matchedBy (`CONTACT_EMAIL | DOMAIN | MANUAL`) | (workspaceId, status, assigneeId); unique (workspaceId, sourceType, sourceId) |
| AskThread / AskMessage | W | userId, messages (question, answer, toolCalls (JSON with tool inputs/outputs ids), citations, agentRunId) | (workspaceId, userId, createdAt) |
| PortalAccess | W | accountId, contactId, tokenHash, expiresAt, lastUsedAt, revokedAt | unique tokenHash |

**Integrations, files, audit**

| Entity | Scope | Key fields | Indexes |
|---|---|---|---|
| Integration | W | provider, status (`CONNECTED | ERROR | DISCONNECTED`), credentialsEnc, scopes, writeBackEnabled (default **false**), writeBackFields[], lastSyncAt, lastErrorPlain?, config | unique (workspaceId, provider) |
| SyncJob | W | integrationId, kind (`FULL | INCREMENTAL | WEBHOOK`), status, cursor, startedAt, finishedAt, counts (JSON), errorPlain?, errorDetailRef? | (workspaceId, integrationId, startedAt) |
| WebhookEvent | W | integrationId, externalEventId, payloadStorageKey, receivedAt, processedAt?, status | unique (workspaceId, integrationId, externalEventId) |
| ExternalRef | W | integrationId?, source, objectType, externalId, internalType, internalId | unique (workspaceId, source, objectType, externalId) |
| FileObject | W | storageKey, filename, mimeType (sniffed), sizeBytes, sha256, uploadedById, scanStatus (`PENDING | CLEAN | REJECTED`), purpose | (workspaceId, createdAt) |
| AuditLog | W | actorType (`USER | AGENT | SYSTEM | INTEGRATION | PORTAL_CONTACT`), actorId, action, targetType, targetId, agentRunId?, summary, before/after (redacted JSON), ip?, createdAt. Append-only (DB trigger blocks UPDATE/DELETE except workspace purge) | (workspaceId, createdAt), (workspaceId, targetType, targetId) |
| OutboxEvent | G* | workspaceId (still carried), type, payload, availableAt, processedAt | (processedAt, availableAt). *Global table read only by the worker's dispatcher; payload carries workspaceId and every handler re-scopes. |

**Entity-name note.** The task brief listed "CSMTPulse". It is modelled as `CsmPulse`, for spec §6C5 CSM Pulse (Q-21).
The task brief's "Role/Membership" is one `Membership` entity with a `role` enum. "Document/Review (QBR)" is `Document` with `kind`.

### 3.3 Interpretations made in the data model

- **[INTERP-1]** Null pillar = no data. A pillar with no inputs is `null` and is excluded from the overall score with
  weights renormalized. It is never 0 (Rule 4, §6A5). With fewer than 2 non-null pillars, `riskLevel = INSUFFICIENT_DATA`, not At Risk.
- **[INTERP-2]** CSM Pulse sits inside the **Relationship** pillar as a component (default weight 30% of that pillar).
  The snapshot also stores `overallExcludingPulse`, and `pulseDisagreement = true` when Pulse=WORRIED while the score
  excluding Pulse is Healthy, or Pulse=FINE while it is At Risk. A Pulse is valid for 30 days (config).
- **[INTERP-3]** Tier is set by rule from ARR bands (config defaults: ≥ 50k High, 10–50k Mid, < 10k Long-tail, in base currency). A CSM can override it, which sets `tierSource=MANUAL`.
- **[INTERP-4]** Field-level protection (§6N3): contract terms and pricing notes are encrypted at the application level
  (AES-256-GCM, key from env `FIELD_ENCRYPTION_KEY`). Contract values and ARR stay queryable plaintext but are readable only with `canViewRevenue`
  (server-side projection strips them otherwise).
- **[INTERP-5]** "Draft in mailbox" (§6N1) creates a draft in the CSM's connected Gmail/Outlook. That counts as a write-back and is gated by the
  integration's `writeBackEnabled`. Without it, the level falls back to "Draft for approval".
- **[INTERP-6]** Outside signals (§6D) at launch come from manual entry or CSV, with a required public source URL and date. Automated news/enrichment feeds are Phase 2 (§6B).

---

## 4. Health engine (deterministic, `src/modules/health/engine/`)

**Principle: code computes every number. The LLM only explains numbers it is given.**

### 4.1 Inputs, components and pillars

Each pillar is a weighted mean of **components**. Each component is a pure function
`(accountBundle, baselines, model, asOf) → { score 0–100 | null, reason: HealthReasonDraft }`.
A component returns `null` when its inputs are missing (Rule 4).

| Pillar | Components (default) | Inputs |
|---|---|---|
| Adoption | active users vs own baseline · active users vs cohort · seat/credit utilization · key features used vs bought · power-user retention | UsageDaily, UserUsageDaily, FeatureUsageDaily, FeatureCatalog, Contract.seatsPurchased |
| Engagement | days since last two-way conversation · days since last meeting · email reply rate (90d) · champion activity recency | Message, Meeting, StakeholderRole |
| Support | open high/urgent tickets · oldest open ticket age vs SLA · repeat-problem count (30d) · escalations (30d) · ticket sentiment share negative | Ticket, Extraction(SENTIMENT/COMPLAINT on tickets) |
| Relationship | champion present & active · decision-maker known · stakeholder breadth · champion change in last 90d · NPS from decision makers · **CSM Pulse** | Contact, StakeholderRole, SurveyResponse, CsmPulse |
| Commercial | failed/late invoices (90d) · seat utilization trend · contraction in last 12m · renewal within notice window without a plan | Invoice, Contract, RevenueEvent, Renewal |
| Sentiment | share of negative vs positive sentiment labels (90d, recency-weighted) across messages/calls/tickets · CSAT/NPS average | Extraction(SENTIMENT), SurveyResponse |

Scoring functions are **piecewise-linear curves over ratios to baseline**, e.g. `activeUsers / baselineMedian`:
≥ 1.0 → 100, 0.8 → 75, 0.5 → 40, ≤ 0.2 → 0. Curves live in `HealthModel.componentConfig`, so a model version
fully reproduces a score.

### 4.2 Baselines and cohorts (§6C3)

- **Own normal.** Trailing median and P25 of each metric over days −104 to −14 (a 90-day window that excludes the last 14 days, so a drop does not pull its own baseline down).
  It needs ≥ 28 days of history; otherwise the own-baseline component is `null` and only cohort comparison applies.
- **Cohort.** Accounts in the same workspace with the same `tier` + `plan` + `employeeBand` (+ `useCase` when set).
  With fewer than 5 accounts the cohort falls back stepwise: drop useCase → drop employeeBand → tier only. The fallback level is recorded in `UsageBaseline.cohortKey`
  and shown in the reason ("compared with 12 Mid-touch accounts on the Growth plan").
- Baselines are computed nightly in SQL (`percentile_cont`) per chunk and stored in `UsageBaseline` (no N+1).

### 4.3 Overall score and risk level

`overall = Σ(w_p × pillar_p) / Σ(w_p)` over non-null pillars. The thresholds from the active model (default ≥ 70 Healthy, 45–69 Watch, < 45 At Risk) apply per tier when overrides exist.
**At Risk needs a reason.** The engine picks the most negative-impact `HealthReason` as `riskReasonId` (DB CHECK, §3.2). An At Risk snapshot with no reason cannot be written.

### 4.4 "Why" explanations (§6C2)

1. Every component returns a `HealthReasonDraft`: pillar, component, direction, signed impact on the overall score
   (computed exactly from weights), value, baseline, cohort value, period, and `sources[]` (ids of the exact rows read,
   e.g. the `UsageDaily` ids for the window, or aggregated as `{sourceType:"UsageDaily", accountId, from, to}` plus the row-id list stored in a side JSON when it exceeds 50 ids).
2. The `message` comes from a **deterministic template per component**, e.g.
   `"Weekly active users fell from {baseline} to {value} ({pct}) against this account's normal ({from}–{to})."`
   Templates are code, tested with snapshot tests, and need no LLM.
3. The writer `health.writeSnapshot()` is the **only** path that inserts snapshots. Its Zod schema requires ≥ 1 reason for
   every non-null pillar, and ≥ 1 source on every EVIDENCE reason. The DB CHECKs back this up.
4. **Health Analyst agent (M4)** reads the snapshot and its reasons and signals, then writes the plain-language "top 1–2 risks/opportunities"
   narrative. Its output schema has `items[{text, citesReasonIds[], citesSignalIds[]}]`, and the citation validator ensures each cited id
   is in its bundle. The narrative is shown beside the numbers, never in place of them.
5. UI: tapping any score opens the reason list. Each source pointer links to the record (usage chart window, ticket, message, invoice).

### 4.5 Model proposal, versioning and back-test (§6C4, §6C6)

- **Versioning.** A `HealthModel` row is immutable once ACTIVE, and edits create a new version. Snapshots reference the version that produced them.
  Activating a model writes an `AuditLog` row and recomputes the current snapshots.
- **Point-in-time reconstruction.** `engine.scoreAsOf(accountId, model, date)` uses only records with timestamps ≤ date
  (UsageDaily.date, Ticket.openedAt/closedAt, Invoice dates, StakeholderRole.validFrom/validTo, Message.sentAt…), so there is no
  look-ahead leakage. Back-test snapshots are written with `isBacktest = true`.
- **Back-test method.**
  - Labelled set: accounts with a known outcome, i.e. `RevenueEvent CHURN` (churned, with its date) or a renewed contract (renewed, with its renewal date). It needs ≥ 5 churned and ≥ 5 renewed accounts.
  - For each labelled account, score weekly as-of dates across the 120 days before the outcome date.
  - **Caught churn:** the account was At Risk at any as-of date ≥ 14 days before churn. **Lead time** = churn date − first At Risk date.
  - **False alarm:** a renewed account was At Risk at any as-of date in its window.
  - Report: "would have flagged X of Y churns, median N days early, with Z false alarms out of W renewals". That is the spec's sentence, built from these fields.
- **Proposal (deterministic, not an LLM).**
  1. Grid search over pillar weights (simplex, step 0.05) × thresholds (healthyMin ∈ {60…80}, watchMin ∈ {35…55}).
  2. Objective: maximize caught churns, then median lead time, subject to false-alarm rate ≤ 25% (config).
  3. Ties go to the weights closest to the default model.
  4. The winning model becomes a DRAFT `HealthModel` with `proposedBy = BACKTEST_PROPOSAL` and its `backtestResult`.
  5. A human approves it or edits it; edits re-run the back-test before activation.
  6. If there is too little history, the system default model is used and labelled "default weights — not yet back-tested on your accounts".
- An LLM may summarize the back-test in words. It is given the computed result object and cites its fields.

### 4.6 CSM Pulse & disagreement (§6C5)

The Pulse buttons live on Account 360 and the Accounts list. A Pulse write triggers a re-score of that account only, so the score updates within seconds.
Disagreements are listed on the Health screen ("Score and CSM disagree": 7 accounts) and are never suppressed.

---

## 5. Signal engine (`src/modules/signals/`)

### 5.1 Split

| Data is… | Mechanism | Examples |
|---|---|---|
| **Structured** | Deterministic rule evaluators (pure TS functions), params from `SignalRule.params` | usage drop vs own normal, key feature stopped, power user quiet, seats near limit / unused, onboarding adoption stall, payment failed/late, contract ending (renewal window 90/60/30), usage hitting paid limit, new team using product, ticket open too long, escalation, repeat problem (≥ N tickets with same theme in 30d), champion silent N days, no meeting in X days, email engagement stops, contact bounced/left, new decision maker, promise late/no owner |
| **Words** | **Extraction** by the Watcher's extraction step (LLM, `AI_MODEL_FAST`) → `Extraction` rows → deterministic rules turn extractions into signals | competitor mentioned, budget concern, promise made, complaint repeated, goal stated, renewal concern, angry sentiment, export/cancel language, intent of inbound email |
| **Outside** | Manual/CSV entry with mandatory public URL + date (INTERP-6) | funding, hiring, leadership change, acquisition |

LLMs never create a `Signal` directly. They create `Extraction`s with a verbatim `quote`. **Code** decides whether an extraction becomes a
signal (e.g. `CANCEL_LANGUAGE` → CRITICAL risk signal; `COMPETITOR` → WARN; 2+ `COMPLAINT` with the same theme in 30d → "complaint repeated").

### 5.2 Rule contract

```ts
interface SignalRuleDef<P> {
  key: string; category: SignalCategory; polarity: "RISK" | "OPPORTUNITY";
  paramsSchema: z.ZodType<P>; defaultParams: P;
  meaning: string; howDetected: string; typicalLeadTime: string; falseAlarmCauses: string; // spec §6D
  evaluate(bundle: AccountBundle, params: P, asOf: Date): SignalCandidate[]; // pure, no I/O
}
// SignalCandidate: { dedupeKey, severity, title, explanation, evidence: {sourceType, sourceId, value, date}[] (min 1) }
```

- Rules are registered in `src/modules/signals/rules/index.ts`. Seeding a workspace inserts one `SignalRule` row per definition.
- **Lifecycle.** A candidate is upserted by `dedupeKey`, which updates `lastSeenAt`. An OPEN signal whose rule no longer produces its key is RESOLVED.
  A CSM can mark one FALSE_ALARM (with a reason), which feeds AI accuracy (§6L4). FALSE_ALARM suppresses the same dedupeKey for a cool-off period (config, default 30d).
- **Real time** (§6E1 "in real time for big signals"). Webhook-ingested events (payment failed, ticket escalated, inbound message) evaluate the rules for that one account immediately
  instead of waiting for the nightly run.

### 5.3 Extraction contract

- One extraction call per source record (a message, ticket thread or transcript chunk ≤ ~8k tokens). Output Zod schema:
  `{ items: [{ kind, quote, payload, confidence }] , sentiment: { label: NEGATIVE|NEUTRAL|POSITIVE|MIXED, quote } }`.
- **Validation.**
  - Each `quote` must be a verbatim substring of the source text (after whitespace normalization), or the item is dropped and counted in metrics.
  - `PROMISE.dueDate` must parse to a date, or it is stored as null with a "no date" flag; the model never invents one.
  - Each `kind` has its own payload schema (e.g. `COMPETITOR: { competitorName }`).
- Idempotent: keyed by `(sourceType, sourceId, promptVersion)`. Re-extraction happens only on a new prompt version, through an explicit backfill job.

### 5.4 Golden fixtures

- `src/modules/signals/__tests__/fixtures/<ruleKey>/*.json`: input bundle → expected candidates, for every deterministic rule,
  including at least one "should NOT fire" (false-alarm) case per rule. They run in `pnpm test`.
- `prompts/__golden__/extraction/*.json`: real-looking fictional texts with expected extraction kinds and quotes.
  - **CI mode (in `pnpm test`):** recorded model responses replay through the validator and mapping, which tests the parsing/validation/rule path deterministically.
  - **Live mode (`pnpm eval`, not in the gate, needs `ANTHROPIC_API_KEY`):** runs the current prompt against the golden set and reports precision/recall per kind. A prompt version bump requires a live eval report in the milestone log.

---

## 6. Agent framework (`src/modules/agents/`)

### 6.1 Definition

```ts
defineAgent({
  key: "renewal-manager",
  version: "1.0.0",                         // code version; bump on any schema/behaviour change
  description: "Builds the renewal plan 90 days out",
  modelTier: "standard",                    // fast | standard | deep → env AI_MODEL_FAST/STANDARD/DEEP
  prompt: { name: "renewal-manager", version: "1.0.0" }, // must match prompts/renewal-manager.md frontmatter
  inputSchema: z.object({ accountId: z.string(), renewalId: z.string() }),
  buildContext: async (db, input) => ContextBundle,       // scoped db only; returns {sourceType, sourceId, fields}[]
  outputSchema: BaseAgentOutput.extend({ ... }),          // Zod
  forbiddenNumericFields: ["confidence", "arrAtRisk"],    // overwritten from deterministic code
  approvalPolicy: { HIGH_TOUCH: "DRAFT_FOR_APPROVAL", MID_TOUCH: "DRAFT_FOR_APPROVAL", LONG_TAIL: "DRAFT_FOR_APPROVAL" },
  actions: { draftEmail: handler, createTask: handler },  // what it may propose
});

const BaseAgentOutput = z.object({
  reasoningSummary: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),        // the model's own confidence, labelled as such in UI
  citations: z.array(z.object({ sourceType: z.string(), sourceId: z.string(), quote: z.string().optional() })).min(1),
  insufficientData: z.object({ missing: z.array(z.string()) }).optional(), // "No contract on file"
  proposedActions: z.array(ProposedAction).default([]),
});
```

- **Model tiers.**
  - `fast`: extraction, intent and sentiment, which are high-volume and narrow.
  - `standard`: drafts, briefs, narratives.
  - `deep`: QBR narrative, Ask AI multi-step tool use, describe-a-play.
  The choice per agent is recorded in its definition with a one-line reason. Model names live only in env (`AI_MODEL_*`).
- **Prompts.** `prompts/<name>.md` with frontmatter `name`, `version`, `agent`, `tier`, `changelog`. The loader fails at startup if any registered agent's
  prompt is missing or its version mismatches. Prompts tell the model to return `insufficientData` instead of guessing.

### 6.2 The 13 agents + Ask AI

| # | Agent (key) | Trigger | Reads | Produces | Default approval | Tier | Milestone |
|---|---|---|---|---|---|---|---|
| 1 | Watcher (`watcher`) | nightly + webhook | new messages/tickets/transcripts | Extractions (→ rules → Signals) | none (internal) | fast | M4 (framework run on notes/tickets text), M9 (full channels) |
| 2 | Health Analyst (`health-analyst`) | band/top-reason change | snapshot + reasons + signals | top 1–2 risks/opportunities narrative | none (internal) | standard | M4 |
| 3 | Champion Guard (`champion-guard`) | champion signals | contacts, roles, messages, meetings | next-best-contact suggestion + draft intro | draft for approval | standard | M9 |
| 4 | Onboarding Manager (`onboarding-manager`) | stall / step due | plan, steps, usage | check-in draft, escalation task | draft for approval | standard | M6 |
| 5 | Adoption Coach (`adoption-coach`) | adoption signals | usage vs bought vs cohort | unused-value finding + nudge draft | draft (long-tail: may auto-send via play) | standard | M6 |
| 6 | Support Risk Agent (`support-risk`) | ticket signals | tickets + extractions | risk flag narrative, Inbox reply draft | draft for approval | standard | M9 |
| 7 | Promise Keeper (`promise-keeper`) | PROMISE extraction, promise late | extractions, tasks | Promise rows (owner/date), internal chase task | internal only | fast | M9 |
| 8 | Renewal Manager (`renewal-manager`) | renewal window | renewal, health, promises, goals | plan, talk track, outreach draft, next step | draft for approval | standard | M7 |
| 9 | Expansion Finder (`expansion-finder`) | opportunity signals | usage limits, new teams, goals | opportunity narrative + conversation draft | draft for approval | standard | M7 |
| 10 | Meeting & QBR Agent (`meeting-qbr`) | meeting upcoming/ended, QBR request | everything for account + computed metrics | pre-call brief, summary + action items, QBR narrative | internal; sharing needs human | standard / deep (QBR) | M10 |
| 11 | Outreach Agent (`outreach`) | approved play step | step intent + voice samples | email/task drafts in company voice | per play step level | standard | M4 (basic, D-30) → M8 |
| 12 | Digital CSM (`digital-csm`) | long-tail play steps | as play step | runs safe steps, hands off on risk/anger/pricing/legal/opportunity | auto only where enabled + guards | standard | M8 (limited form per §8) |
| 13 | Leader Reporter (`leader-reporter`) | weekly | ReportSnapshot computed data | weekly digest narrative | internal | standard | M11 |
| 14 | Ask AI (`ask-ai`) | user question | tool calls over scoped data | cited answer; proposed actions → confirmation | confirm every change | deep | M11 |

### 6.3 Execution, retry and idempotency

- Queue `agents` uses per-workspace concurrency limits (BullMQ group keys) and a global rate limit tied to the Anthropic tier.
- Retry policy:
  - Transient provider errors (429/5xx/timeouts) retry up to 4 times with exponential backoff and jitter. The same `AgentRun` row moves to RUNNING again (`attempt` counter).
  - Validation failures are not retried beyond one repair call.
- Side effects run **after** the output is persisted, each keyed by `(agentRunId, actionIndex)` with unique constraints on Approval/Task/OutboundMessage `sourceKey`.
  A crash mid-way therefore never duplicates a draft or task.
- Cost guard: per-workspace daily token budget (config). When it is exceeded, runs are `SKIPPED` with reason "budget", which shows on Settings › AI.

### 6.4 Audit and display

- Every UI surface that shows AI text renders it from an `AgentRun` (or a row carrying `agentRunId`) through `<AiText run=… />`.
  That component shows the citations, the model confidence label and a "what it read" link. It renders nothing if the run status ≠ SUCCEEDED.
- Agent pages (Settings › AI team) show per-agent: recent runs, what each read (inputRefs), decided (output), did (actionTaken),
  approval decisions, and accuracy (from OutcomeRecord, M11).

### 6.5 Outcome write-back (7/30/90 days)

- An `OutcomeRecord` is created when a RISK or OPPORTUNITY signal of severity ≥ WARN opens, or when an agent flags one.
  `arrAtFlagMinor` is taken from the account's ARR at that moment.
- `actionTaken` becomes ACTED when any linked approval is approved, task completed, outbound sent, or play step run within the window. It is IGNORED
  if nothing happened by day 7 (still re-evaluated later).
- `outcomes.checkpoint` (daily) evaluates each record at +7, +30 and +90 days with deterministic rules over records:
  - REPLIED: an inbound message from the account after the first action;
  - MEETING_HELD: a meeting with the account after the flag;
  - RECOVERED: risk level improved to Healthy/Watch and stayed for 14d;
  - RENEWED / EXPANDED / CONTRACTED / CHURNED: from RevenueEvent/Renewal.
  Each status stores evidence sources.
- `valueSavedMinor` = ARR at flag when a RISK record ends RENEWED/RECOVERED **and** was ACTED. `valueExpandedMinor` = the positive EXPANSION delta.
  These are deterministic and labelled as attributed, not proven causal (Q-15).
- `isTrueAlarm`: a RISK flag that ended CHURNED/CONTRACTED, or a CSM-agreed flag. A false alarm is one marked FALSE_ALARM, or Healthy and renewed by +90d with no action (Q-16).

---

## 7. Security design

### 7.1 Tenant isolation: two layers

1. **Application (primary, by construction).** `src/lib/db/scoped.ts` exports `scopedDb(ctx)` only. The raw `PrismaClient` is
   exported from `src/lib/db/raw.ts` and an ESLint `no-restricted-imports` rule allows it only in: `src/lib/db/**`, `prisma/seed.ts`,
   `src/lib/auth/**` (global identity tables), and the outbox dispatcher. The extension:
   - injects `workspaceId` into `where` for find/update/delete/count/aggregate/groupBy on every [W] model, and into `data` for create/upsert;
   - **throws** if a caller passes a different `workspaceId`;
   - throws on `$queryRawUnsafe`, while the tagged `$queryRaw` must include `${ctx.workspaceId}`, a rule checked by a custom lint rule and a test helper.
2. **Database (defense in depth, §6N3 "at the database level").**
   - Postgres RLS is `ENABLE` + `FORCE` on every [W] table, with policy `workspace_id = current_setting('app.workspace_id', true)`.
   - The app connects as a non-owner role `app_user`, and migrations run as the owner role.
   - The scoped client wraps each operation in a transaction that begins with `SELECT set_config('app.workspace_id', $1, true)`.
   - Worker jobs use the same `scopedDb({ workspaceId })` built from the job payload.
3. **Composite FKs** (§3.1) prevent cross-tenant references.
4. **Tests that try to break it (M1, extended every milestone).** `src/lib/db/__tests__/tenant-isolation.test.ts` creates workspaces A and B and asserts:
   - reads, updates and deletes through A's client never touch B's rows;
   - raw SQL without the setting returns 0 rows (RLS);
   - a cross-tenant FK insert fails;
   - every Server Action with an id parameter returns 404 for B's ids. A test enumerates registered actions so new ones are covered automatically.

### 7.2 RBAC matrix

Permissions are checked server-side by `requirePermission(ctx, perm)`. Book scope: CSM = own accounts by default (`bookScope=OWN`).

| Permission | Admin | CS Leader | CSM | Viewer |
|---|---|---|---|---|
| View accounts / Account 360 | all | all | own book (configurable TEAM/ALL) | all (read-only) |
| Edit accounts, contacts, notes, tasks | ✓ | ✓ | own book | ✗ |
| CSM Pulse | ✓ | ✓ | own book | ✗ |
| Decide approvals | ✓ | ✓ | own book | ✗ |
| Mark signal false alarm | ✓ | ✓ | own book | ✗ |
| Create/publish plays, enable auto-send | ✓ | create + publish; auto-send ✗ (Admin only) | create drafts | ✗ |
| Health model edit/activate | ✓ | propose; activate ✗ | ✗ | ✗ |
| Integrations connect / write-back toggle | ✓ | ✗ | ✗ | ✗ |
| Users, roles, data controls, export/delete | ✓ | ✗ | ✗ | ✗ |
| Campaign send | ✓ | ✓ | draft only | ✗ |
| Reports (non-financial) | ✓ | ✓ | own book | ✓ |
| Audit log view/export | ✓ | view | ✗ | ✗ |
| **Revenue/financial views** (ARR, contract value, forecast, Revenue, money in ledger) | requires `canViewRevenue` flag on Membership, for any role. Admins have it by default |

Without `canViewRevenue`, money fields are stripped server-side (projection helper `redactFinancials`) and replaced with "Restricted".

### 7.3 Approval levels (§6N1)

These are the levels, in order: `NOTIFY_ONLY` < `DRAFT_FOR_APPROVAL` < `DRAFT_IN_MAILBOX` < `DO_AUTOMATICALLY` < `SEND_AUTOMATICALLY`.

- Each play step and agent action resolves an **effective level** = min(step setting for the account's tier, workspace ceiling, sensitive-topic cap).
- **Defaults.**
  - High-touch: DRAFT_FOR_APPROVAL for anything customer-facing.
  - Mid-touch: DRAFT_FOR_APPROVAL for customer-facing steps, DO_AUTOMATICALLY for internal steps (task, notify).
  - Long-tail: SEND_AUTOMATICALLY is allowed only on steps marked `safe: true` in seeded plays, only after an Admin enables auto-send for that play, and only after the guards pass.
- `DO_AUTOMATICALLY` covers internal actions only (create task, notify, update an internal field). It never covers customer contact or external write-back. External write-back is a separate `WRITE_BACK` approval unless the integration's write-back setting allows it automatically.

### 7.4 Customer-send enforcement point and auto-send guards (§6J4, Rule 3)

- **Single choke point.** `src/modules/outbound/dispatch.ts → dispatch(outboundMessageId)` is the only importer of
  `src/lib/email/customerTransport.ts` (ESLint restricted import + a test that greps the import graph).
- `dispatch` sends only if:
  - (a) `sendMode=APPROVED` and the linked Approval is APPROVED/EDITED_APPROVED by a user with permission; **or**
  - (b) `sendMode=AUTO` and **all** guards pass (pure function `evaluateGuards(ctx) → GuardResult[]`, built test-first).
- **Guards** (each failure sets `HELD` and creates an Approval instead; nothing is dropped silently):
  1. Contact emailed in the last 3 days (any OutboundMessage SENT to that contact).
  2. Another play emailed the account in the last 48 hours → goes to Approvals.
  3. Quiet hours in the customer's time zone (contact tz → account tz → **unknown = hold for approval**; default quiet 19:00–08:00 plus weekends, config).
  4. Open serious support ticket (priority HIGH/URGENT or `isEscalated`) → hold.
  5. Account `lifecycleStage = LOST` → never.
  6. Sensitive topic: cancellation, pricing, legal, security, complaint, escalation → **never auto, always human**.
     Detection is conservative OR: a deterministic keyword/regex list on the triggering inbound text and the draft, **or** an `INTENT`/`CANCEL_LANGUAGE`/`COMPLAINT` extraction, **or** the play step is tagged sensitive.
     Any hit sets `Approval.isSensitive=true`, and the effective level is capped at DRAFT_FOR_APPROVAL. This cap cannot be overridden by any setting.
  7. Suppression list (unsubscribe/bounce) → never send (applies to approved sends too).
  8. Workspace auto-send master switch off → never auto.
- **Pacing.** A per-workspace send rate (config), with campaigns paced separately.

### 7.5 Secrets

- Env vars are validated at boot by a Zod env schema (`src/lib/config/env.ts`). `.env.example` lists names only.
- The logger (pino) has redaction paths for tokens, authorization headers, `credentialsEnc` and email bodies. AI request/response *content* is never logged, only ids, token counts and latency.
- OAuth tokens and API keys for integrations are stored encrypted (`credentialsEnc`, AES-256-GCM with `FIELD_ENCRYPTION_KEY`, key id prefix for rotation).

### 7.6 File-upload safety

- Uploads go through signed POST to S3 under `ws/<workspaceId>/files/<cuid>`. Size cap 25 MB (config). The MIME type is sniffed from bytes against an allowlist
  (pdf, docx, txt, md, csv, vtt, srt, json transcripts, png, jpg).
- `FileObject.scanStatus` starts PENDING. A scan hook (interface `MalwareScanner`) runs; in dev the scanner is a no-op that marks CLEAN, and prod requires a configured scanner (Q-18).
  Nothing is processed (text extraction, Ask-AI) until CLEAN.
- Downloads use short-lived signed URLs with `Content-Disposition: attachment`. Uploaded HTML is never served inline from our origin.

### 7.7 Export & delete (§6N7)

- **Export:** an Admin requests it; a worker builds a ZIP of JSON/CSV per entity plus files and stores it with a 7-day signed link. The export is audited.
- **Delete:** an Admin requests it with typed confirmation; the workspace is marked `deletionRequestedAt`; after a 7-day grace period (config) a purge job deletes all [W] rows and S3 prefixes, then a final non-tenant tombstone record is written. The timeline shown in the UI is "within 30 days" (Q-10).

### 7.8 Never train / never share (Rule 8)

- `src/lib/ai` is the only module that talks to Anthropic. Each call carries only the current workspace's bundle. The provider config documents that API data is not used for training under the commercial terms, which must be verified at M12 (Q-19).
- No cross-workspace few-shot examples, caches or embeddings. Voice samples are per workspace.

---

## 8. Integrations design (`src/modules/integrations/`)

### 8.1 Adapter interface

```ts
interface IntegrationAdapter<Cfg> {
  provider: Provider; category: "CRM" | "BILLING" | "SUPPORT" | "USAGE" | "EMAIL" | "CALENDAR" | "CALLS" | "CHAT";
  configSchema: z.ZodType<Cfg>;
  auth: { kind: "oauth2"; authorizeUrl(state): string; exchange(code): Credentials; refresh(c): Credentials }
      | { kind: "apiKey"; validate(key): Promise<void> };
  testConnection(ctx): Promise<ConnectionCheck>;               // plain-words result
  sync(ctx, { kind: "FULL" | "INCREMENTAL", cursor? }): AsyncIterable<NormalizedBatch>; // pages
  webhook?: { verify(req): boolean; toEvents(payload): NormalizedEvent[] };
  writeBack?: { fields: WriteBackField[]; push(ctx, change): Promise<void> };            // only via gate
  describeError(err): { plain: string; action?: string };       // §6B "errors in plain words"
}
```

- Adapters output **normalized records** (`NormalizedAccount`, `NormalizedContact`, `NormalizedOwner`, `NormalizedContract`, `NormalizedSubscription`, `NormalizedInvoice`, `NormalizedUsageDay`,
  `NormalizedTicket`, `NormalizedMessage`, `NormalizedMeeting`, `NormalizedTranscript`). One shared `ingest` service upserts them via `ExternalRef` mapping.
  The domain modules therefore never know which provider a record came from.
- **Write-back gate.** `integrations.writeBack(integrationId, change)` checks `writeBackEnabled && field ∈ writeBackFields`,
  writes an AuditLog row, and requires an approval unless the step level allows it. Read-only is the default (Rule 7).
- **Sync status UI.** Every integration shows last run time, record counts and the last error in plain words (`describeError`).
- **Testing.** Each adapter has contract tests against recorded fixture payloads (no live network in `pnpm test`). Live verification uses sandbox
  credentials manually and is recorded in the milestone log.

### 8.2 Launch set (§6B) in build order

| Order | Adapter(s) | Category | Milestone |
|---|---|---|---|
| 0 | CSV import (accounts, contacts, contracts, invoices, usage, tickets, outside signals) + manual entry + seed | all | M2 |
| 1 | HubSpot, Salesforce | CRM | M5 |
| 2 | Stripe, Chargebee | Billing | M5 |
| 3 | Slack (signals, approvals with interactive approve, digests) | Chat | M5 |
| 4 | Segment / Usage API (our own ingest endpoint), Mixpanel, Amplitude | Usage | M6 |
| 5 | Zendesk, Freshdesk | Support | M9 |
| 6 | Google + Microsoft email (Gmail API / Graph) | Email | M9 |
| 7 | Google + Microsoft calendar | Calendar | M10 |
| 8 | Fireflies, Gong, Zoom (recordings/transcripts) | Calls | M10 |

The Usage API (our own ingest endpoint) is modelled as an `Integration` row with provider `USAGE_API`. Its per-workspace ingest key is stored
hashed, shown once and rotatable. Incoming events wait in the queue only until a worker aggregates them into `UsageDaily`, `UserUsageDaily` and `FeatureUsageDaily`.
Raw events are not stored (D-23, Q-33).

Phase 2 adapters (Intercom, Pendo, Snowflake/BigQuery, Teams, Notion/Drive, Jira/Linear, enrichment, news) are out of scope.
The adapter interface is the seam for them.

### 8.3 Zero-integration path

The product is fully usable with **no** live integration:
- `pnpm db:seed` loads the demo workspace (`docs/SEED_DATA.md`).
- CSV import (M2) covers every entity a buyer needs for a day-1 queue, with downloadable CSV templates and column validation errors in plain words.
- Manual create/edit exists for accounts, contacts, contracts, tasks, notes, promises and outside signals.
- The AI provider has a `RecordedProvider` (tests only, selected by `AI_PROVIDER=recorded`, which is refused at boot when `NODE_ENV=production`). That allows e2e tests without network.
  This mock lives in tests and seed tooling only (Rule 6). The dev environment uses the real Anthropic API when `ANTHROPIC_API_KEY` is set. When the key is absent, AI features show "AI is not configured" instead of fake output.

---

## 9. Today queue ranking (deterministic, §6F1)

`rankScore = moneyWeight × urgency`, both computed in code and stored with `rankReasons`.
- `moneyWeight = 1 + log10(1 + ARR_in_base_units / 1000)`. Without revenue permission the user still sees the ranking, but not the ARR value.
- `urgency` is the max over the item's drivers: overdue task (1.0 + 0.1/day overdue, capped), due today (0.8), CRITICAL signal (0.9), WARN (0.5), renewal ≤ 30d (0.9) / ≤ 60d (0.6) / ≤ 90d (0.4), meeting today (0.7), approval waiting > 24h (0.7).
- Only the user's book. Ties are broken by renewal date, then account name. Pagination is 25 per section.

---

## 10. Testing design

| Layer | Tool | What | Where |
|---|---|---|---|
| Unit (test-first for core) | Vitest | health components/curves/aggregation, baselines, back-test math, signal rule evaluators, extraction validators (quote substring, schemas), citation validator, guard evaluator, sensitive-topic detector, approval-level resolver, today ranking, renewal confidence, expansion estimate, outcome checkpoint rules, play safety check, money math | `src/modules/*/__tests__/*.test.ts` |
| Integration | Vitest + real Postgres (docker, per-run schema) | services with DB, tenant isolation suite, RLS, composite FKs, job handlers end-to-end with in-process BullMQ, CSV import, adapter ingest with fixture payloads, agent executor with RecordedProvider | `*.int.test.ts` beside modules |
| Golden fixtures | Vitest (CI replay) + `pnpm eval` (live, outside gate) | signal rules (fire / not fire), extraction prompts, agent output schemas | `src/modules/signals/__tests__/fixtures`, `prompts/__golden__` |
| E2E | Playwright | demo scripts per milestone against seeded DB (sign in → Today → approve draft → audit shows it) | `e2e/*.spec.ts` |
| Accessibility | Playwright + axe-core | every new screen in its milestone's e2e | `e2e/a11y.spec.ts` |

- **Gate:** `pnpm gate` = `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. E2E (`pnpm test:e2e`) runs at the end of every milestone and in CI, but stays out of `gate` so that commits remain fast (D-14).
- The test DB comes from `docker compose`. `pnpm test` refuses to run against a database URL without `_test` in its name.
- **Seed** is deterministic: a fixed PRNG seed and dates relative to `SEED_TODAY` (default `2026-11-02`), so tests can assert exact states.

---

## 11. Performance approach

- **Lists:** cursor pagination (default 50) on Accounts, Signals, Approvals, Inbox, Tasks, Promises, AuditLog. Server-side filters use indexes that start with `workspaceId`.
- **Account/health paths:** batch loaders per chunk (`findMany({ where: { accountId: { in: ids } } })`), SQL aggregates for usage windows, no per-row queries in loops.
  An integration test counts queries for Account 360 and the Accounts list (Prisma query event hook) and fails above a fixed budget.
- **Nightly jobs:** chunked per workspace (200 accounts/chunk), with bounded concurrency per workspace so a big tenant cannot starve others.
- **Expensive AI:** only on change (band changed, new text, window entered), deduplicated by idempotency key, with per-workspace daily budgets.
- **Caches:** TodayItem table, HealthScoreSnapshot "current" pointer on Account, ReportSnapshot for leader reports.

---

## 12. UI principles (applies to every screen)

- shadcn/ui + Tailwind, neutral palette. Colour is reserved mainly for risk: At Risk red, Watch amber, Healthy muted green, Insufficient data grey with the label "Not enough data".
- Dense tables where work needs density (Accounts, Approvals, Signals). Calm detail views elsewhere. No marketing copy inside the app.
- Spec words for navigation: Today, Approvals, Accounts, Account 360, Health, Onboarding, Renewals (Renewal Radar), Expansion, Plays, Inbox, Meetings & QBRs, Success Plans, Revenue, Reports, Ask AI, Customers (Portal), Settings; in-page: Promise Tracker, Outcome Ledger.
- Every screen has empty, loading and error states. Keyboard navigable, visible focus, labelled controls, contrast AA. Responsive down to 375 px (tables collapse to cards).
- Every number has a "why" affordance, and every AI text block shows its sources.
