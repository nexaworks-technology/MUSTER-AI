# IMPLEMENTATION PLAN: NexaWorks AI CSM (V1 / spec Phase 1)

Twelve milestones, M1–M12. The app is runnable and demoable on the seeded demo workspace after **every** milestone, with a walking skeleton
first. Each milestone has a self-contained session prompt in `docs/milestones/M<n>.md` and, once done, a log in
`docs/milestones/M<n>-LOG.md`. Entity and module names match `docs/ARCHITECTURE.md` exactly.

Every milestone is "done" only when all of these hold:
- `pnpm gate` is green;
- the milestone's acceptance checks pass with evidence;
- the 9 non-negotiable rules in `CLAUDE.md` hold for everything shipped;
- `pnpm test:e2e` passes for the milestone's demo script;
- docs are updated.

Scope discipline:
- Spec Phase 2/3 items (custom agents, full Docs editing, in-app SDK, warehouse connectors, Teams, Jira/Linear, Intercom, Pendo, enrichment/news feeds, advanced forecasting, custom objects, multi-product/region, SSO/SCIM, data residency, SOC 2 Type II completion) are **out**. Seams only, where noted.
- The spec's "Phase 0 canned prototype" is not built separately (D-15). The seeded workspace plus M2–M4 provide the design-partner demo with real code paths.

## Progress

- [x] M1: Foundation, Auth & Tenancy (2026-11-02, see `docs/milestones/M1-LOG.md`)
  - ⚠ **Open follow-up, acceptance #16 PARTIAL:** `docker compose up -d postgres redis minio` has not been run, because Docker is not installed on the build machine. M1 was built and verified on the documented fallback `pnpm services:native` (D-31). Close this only by installing Docker (OrbStack or Docker Desktop), running that command successfully and recording the output in `M1-LOG.md`. It must not silently become PASS. **Home: M12** (`docs/milestones/M12.md` §2 "Carried verifications", step 15, acceptance #23).
- [x] M2: Data, CSV Import & Account 360 (2026-11-02, see `docs/milestones/M2-LOG.md`)
- [x] M3: Health & Signals (2026-11-03, see `docs/milestones/M3-LOG.md`; Q-44, Q-45 open)
- [x] M4: Agent Framework, Today & Approvals
- [x] M5: Integrations Core
- [x] M6: Onboarding & Adoption
- [ ] M7: Renewals, Revenue & Expansion
- [ ] M8: Plays Engine
- [ ] M9: Conversations, Inbox, Promises & Sentiment
- [ ] M10: Meetings, QBR, Success Plans & Portal
- [ ] M11: Ask AI, Reports & Outcome Ledger
- [ ] M12: Hardening & Deploy

---

## M1: Foundation, Auth & Tenancy
**Goal:** a running, tenant-safe walking skeleton. A user signs in, lands in the demo workspace and sees the app shell with real (empty) navigation.
**Spec:** §6N2 (audit write), §6N3 (isolation), §6N5 (roles), §6N4 (provider policy seam), §10.1 (PRODUCT_NAME), §10.2 (pricing config), §5 (navigation shell).
**Depends on:** nothing.
**Deliverables:**
- **Scaffold and tooling.**
  - `git init`; Next.js (App Router, TS strict) + Tailwind + shadcn/ui; pnpm scripts exactly as in CLAUDE.md, including `gate`.
  - ESLint (incl. restricted imports for raw DB + customer transport), Prettier, Vitest, Playwright + axe.
  - docker-compose (postgres, redis, minio) with explicit `name:`; Zod env schema; `.env.example` (names only).
- **Prisma and tenancy.** Prisma with `Workspace`, `User`, `AuthAccount`, `Session`, `VerificationToken`, `Membership`, `Invitation`, `WorkspaceSettings`, `AuditLog`, `OutboxEvent`. The tenancy infrastructure is ready for every later [W] model:
  - `scopedDb` extension;
  - RLS migration helper;
  - `app_user` role;
  - composite-FK convention;
  - a model-registry test that fails if a [W] model lacks `workspaceId`, an RLS policy or the composite unique.
- **Auth.** Auth.js with credentials + Google and **database sessions**. The credentials-with-DB-sessions approach follows D-07. Workspace switcher.
- **Workspace settings.** Invitations, roles (Admin / CS Leader / CSM / Viewer + `canViewRevenue`), `requirePermission`, Settings › Users screen.
- **Libraries.** `src/lib/audit` write primitive (append-only trigger); `src/lib/jobs` (BullMQ queues, outbox, worker entry `src/worker/index.ts`, `pnpm dev` runs web + worker); `src/lib/ai` provider skeleton with env model tiers and prompt loader + frontmatter validation (no agents yet); `src/lib/email` with log-only transport; `src/lib/storage`; `src/config/product.ts` (PRODUCT_NAME), `src/config/pricing.ts` (structure only, `isFinal: false`).
- **App shell.** Every spec nav item, each rendering an honest empty state that says which milestone builds it. Pages exist only for completed milestones; nav entries for later ones are hidden behind a `features` config. No "coming soon" boxes inside screens claimed as done.
- **Seed v0.** Demo workspace "Larkspur Analytics" plus 5 users across roles (credentials in seed file, dev-only).
**Acceptance:**
- (a) `pnpm gate` green.
- (b) Sign-in via credentials works (e2e); Google provider configured from env.
- (c) The tenant-isolation suite passes: cross-workspace read/update/delete fail; RLS blocks raw SQL without the setting; the composite-FK cross-tenant insert fails.
- (d) RBAC unit tests for the matrix.
- (e) Audit row on sign-in, invite, role change; UPDATE on AuditLog rejected.
- (f) No secret in repo (`git grep` check script).
- (g) Shell passes axe on desktop + 375 px.
**Demo:** sign in as the Admin → see the shell with PRODUCT_NAME → invite a CSM → sign in as the CSM → Settings is hidden → audit log row exists (DB query in log).

## M2: Data, CSV Import & Account 360
**Goal:** one true account view from CSV/manual/seed data. Accounts list, Account 360 with full timeline, people map, contracts, tasks, notes, segments.
**Spec:** §6A1–A6, §6B (CSV), §6F3 (tasks, manual), §6F4 (notes), §6F5 (segments), §5 Accounts + Account 360, §6N3 field-level protection, §6D Outside (manual/CSV, INTERP-6).
**Depends on:** M1.
**Deliverables:**
- **Models (with RLS + composite FKs).** Account, Contact, StakeholderRole, Contract, Subscription, Invoice, RevenueEvent (computed from contracts/subscriptions by rule), UsageDaily, UserUsageDaily, FeatureUsageDaily, FeatureCatalog, Ticket, Conversation, Message, Task, Note, NoteTemplate, Segment, DataQualityIssue, MissingDataPrompt, ExternalRef, FileObject.
- **CSV import.**
  - Templates and a column mapper, with validation errors in plain words, a dry-run preview and idempotent upsert via ExternalRef.
  - Covers accounts, contacts, contracts, invoices, usage, tickets and outside signals. Outside signals are stored as a pending import consumed in M3, or as Signal rows if M3's table exists; see the M2 prompt.
- **Accounts list.** Search, filter, inline edit, cursor pagination, and tier with rule + override (INTERP-3).
- **Account 360 tabs.** Overview, People (stakeholder map + champion), Usage (charts from real rows only), Tickets, Conversations, Contracts & billing (`canViewRevenue` + encrypted terms), Tasks, Notes, Timeline (merged, time-ordered).
- **Data helpers.** Missing-data helper (inline single question, skippable, snooze). Data-quality checker (duplicates/stale/invalid, suggested fix applied only on confirm, safe bulk fix).
- **Work items.** Tasks (manual create, owner, due). Notes with templates, tags, @mentions (in-app Notification). Segments (filter DSL, Zod-validated).
- **Seed v1.** The full demo dataset per SEED_DATA.md, minus derived health/signals.
**Acceptance:**
- Import of every template is idempotent (re-import = no duplicates).
- Account 360 shows "No contract on file" style empty states for missing data.
- A user without `canViewRevenue` cannot get contract values from any action (test).
- Data-quality fix only after confirm (test).
- The Accounts list and Account 360 stay within query budgets (no N+1 test).
- Tenant suite extended to all new models.
- axe passes.
**Demo:** import the sample CSV → Accounts list → open "Brightwell Logistics" → see people (champion), contract, usage, tickets, timeline → answer a missing renewal-date prompt → create a task and a note with a mention.

## M3: Health & Signals
**Goal:** a deterministic 6-pillar health score with proof, CSM Pulse, a back-tested model proposal, and the nightly signal engine for structured data.
**Spec:** §6C1–C7, §6D (Usage, People-structured, Support-structured, Money, Outside), §5 Health screen, §4 nightly loop.
**Depends on:** M2.
**Deliverables:**
- **Models.** HealthModel, HealthScoreSnapshot, HealthReason, CsmPulse, UsageBaseline, SignalRule, Signal.
- **Engine (test-first).** Components, curves, baselines/cohorts, aggregation with null pillars, risk levels, the reason templates, and `writeSnapshot` with DB CHECKs.
- **Back-test and proposal.** Point-in-time `scoreAsOf`, back-test and grid-search proposal, the model review UI (draft → back-test result sentence → approve/activate, Admin), and versioning.
- **Signal rules (test-first, golden fixtures incl. not-fire cases).** All structured rules listed in ARCHITECTURE §5.1 that M2 data supports. Text-based rules come in M9. Promise rules come in M9 with the Promise model.
- **Signal lifecycle.** Dedupe, resolve, false alarm, and the four spec fields on each rule (Settings › Signals).
- **Nightly pipeline.** Scheduler → chunked `signals.evaluateChunk` → `health.scoreChunk`, idempotent, plus real-time evaluation hook for single-account changes.
- **UI.**
  - Health screen: by band, moved today/this week with reasons, and score-vs-CSM disagreements.
  - Account 360 Health tab: 6 pillars, tap → reasons → source records.
  - Pulse buttons.
  - Signals list per account and portfolio.
- **OutcomeRecord** model created; rows are written when RISK/OPPORTUNITY signals ≥ WARN open (evaluation comes in M4/M7/M11).
**Acceptance:**
- Health unit tests cover null pillars (missing data never lowers a score), the At Risk reason requirement, baseline vs cohort, and the threshold edges.
- The back-test on seed history returns a deterministic expected result (fixture).
- Inserting an At Risk snapshot without a reason fails at the DB.
- Every rule has fire + not-fire fixtures.
- A nightly run is idempotent (run twice = same rows).
- The UI shows reasons with clickable sources for every pillar of a seeded At Risk account.
**Demo:** run `pnpm jobs:nightly --workspace demo` → Health screen → "Brightwell Logistics" At Risk → tap Adoption → "Weekly active users fell from 41 to 17…" with linked usage rows → CSM taps "Worried" on a Healthy account → disagreement shown → Settings › Health model → proposed model with "would have flagged X of Y churns, N days early, Z false alarms" → approve.

## M4: Agent Framework, Today & Approvals
**Goal:** the audited agent runtime, plus the CSM's daily home. Today queue, Approvals queue, the approval-gated customer send path, the first agents, and the audit viewer.
**Spec:** §6E (framework; agents 1 Watcher-basic, 2 Health Analyst), §6F1 Today, §6F2 Approvals, §6F3 overdue escalation, §6N1 levels (model), §6N2 audit viewer + export, §6J4 guards (function + enforcement point), Rule 3/5.
**Depends on:** M3.
**Deliverables:**
- **Models.** AgentDefinition, AgentRun, Approval, OutboundMessage, EmailSuppression, TodayItem, Notification.
- **`defineAgent` framework.**
  - ContextBundle, prompt loader, model tiers via env, structured output from the Zod schema via `output_config.format` (D-35; supersedes "via tool schema").
  - Repair-once, then the citation validator (ids in bundle + verbatim quotes) and the forbidden-numeric overwrite (all test-first).
  - Idempotent runs, retry policy, side-effect keys, per-workspace token budget.
  - `RecordedProvider` for tests; "AI is not configured" state when no key.
- **Agents.**
  - Health Analyst (narrative on band change).
  - Watcher-basic (extraction on Notes and Ticket text that already exist, validating the extraction pipeline end to end; full channels come in M9).
  - Outreach Agent in basic form (D-30): one check-in draft for a CSM-requested action, always routed to Approvals.
  - Prompts `prompts/health-analyst.md`, `prompts/watcher-extraction.md` and `prompts/outreach.md`.
- **`<AiText>` component.** Renders only SUCCEEDED runs, with sources and the confidence label.
- **Approvals queue.** Reason + proof, approve / edit-then-approve / reject, bulk with confirmation.
- **Outbound dispatch.** The single send path via `src/lib/email` (log transport in dev). `evaluateGuards` and the sensitive-topic detector are fully implemented and tested now. Auto mode stays disabled until M8, but every send already passes through dispatch.
- **Today queue.** Deterministic ranking (§9 ARCHITECTURE): tasks, new signals, meetings (from M10 data later; the section shows an honest empty state), approvals. Own book only.
- **Overdue tasks.** Escalate to the leader view (Notification + Today for CS Leader).
- **Audit.** Viewer + CSV/JSON export (Admin/Leader).
- **Agent pages.** Settings › AI team: runs, inputs, outputs, actions.
- **OutcomeRecord.** `actionTaken` tracking (ACTED/IGNORED) wired to approvals/tasks/sends; the 7-day checkpoint for REPLIED/RECOVERED.
**Acceptance:**
- An UNCITED or INVALID run renders nothing (test).
- Every SUCCEEDED run has prompt version, model, inputRefs, output, reasoning, confidence (DB CHECK + test).
- Retrying a job does not duplicate approvals/tasks (test).
- No customer email can be sent except via dispatch (lint + import-graph test); sending without an approved Approval throws (test).
- Guard tests cover all 8 guards incl. unknown time zone → hold and sensitive → never auto.
- Today ranking unit tests.
- e2e: approve a draft → OutboundMessage SENT (log transport) → AuditLog + OutcomeRecord ACTED.
**Demo:** sign in as a CSM → Today shows ranked items with reasons → open an At Risk account → Health Analyst narrative with citations → Approvals → edit and approve a check-in draft → see it in the dev email log → Audit log shows run + approval + send.

## M5: Integrations Core
**Goal:** the adapter framework and the first live connectors (CRM, billing, Slack), the write-back gate, and the guided setup flow, so a buyer can go live from HubSpot/Stripe on day 1.
**Spec:** §6B (rules + HubSpot, Salesforce, Stripe, Chargebee, Slack), §6F (Slack approvals), §6J3 Slack, §6O1 setup (connect → import → propose health model + segments → back-test → go live).
**Depends on:** M4.
**Deliverables:**
- **Models.** Integration, SyncJob, WebhookEvent.
- **Adapter framework.** The adapter interface, OAuth flows with encrypted credentials, the incremental sync engine, webhook intake with verification + dedupe, the `ingest` normalizer, and plain-words errors + the sync status UI.
- **Write-back gate.** Off by default, per field, audited.
- **Adapters.** HubSpot, Salesforce (accounts/companies, contacts, owners, deals→contracts where configured), Stripe, Chargebee (customers, subscriptions, invoices, payment failures; webhooks trigger real-time signals), Slack (signal + approval notifications; approve/reject from Slack via signed interactivity; daily digest).
- **Contract tests** with recorded fixtures for every adapter.
- **Setup wizard.** Connect → import → proposed tiers/segments → proposed health model + back-test (M3) → review → go live. The plays step is added in M8.
**Acceptance:**
- Adapter contract tests pass.
- Re-sync is idempotent.
- A webhook replay is deduped.
- Write-back is refused when disabled (test).
- Slack approve requires a valid signature and a mapped user with permission (test).
- A sync error shows in plain words.
- Live sandbox verification steps are recorded in the log; if no sandbox creds exist, that is marked DEFERRED, not PASS.
**Demo:** Settings › Integrations → connect Stripe (test mode) → sync → a failed payment webhook → "Payment failed" signal appears in Today within a minute → Slack message with an Approve button approves a drafted payment check-in.

## M6: Onboarding & Adoption
**Goal:** every new customer on a plan, stalls flagged with the likely blocker, time-to-value vs cohort, adoption view, usage connectors.
**Spec:** §6G1–G4, §6E4 Onboarding Manager, §6E5 Adoption Coach, §6D usage "adoption stall in onboarding", §6B Mixpanel/Amplitude/Segment/Usage API, §5 Onboarding.
**Depends on:** M5.
**Deliverables:**
- **Models.** OnboardingTemplate, OnboardingPlan, OnboardingStep.
- **Onboarding.**
  - Plan per account from template by tier/plan, with measurable value definition.
  - Time-to-value vs cohort (deterministic) and stall detection rules with the likely blocker (overdue customer-side step, no usage of key feature, no login).
  - Sales handoff assembly: contracts, CRM notes/deal fields, stated goals (Goal records from extraction, M9 adds call-based), key people, risks. Every item has sources.
- **Agents.**
  - Onboarding Manager: check-in drafts and escalation tasks.
  - Adoption Coach: unused-value finding vs bought and vs cohort, plus the nudge draft.
- **Adoption view on Account 360.** Seats/credits used, features used vs bought, power users, decline curves. In CS language.
- **Usage connectors.** Usage ingest API (authenticated per-workspace key; Segment-compatible `track/identify` subset), Mixpanel, Amplitude adapters.
- **Onboarding screen.** All new accounts, where stuck, what unblocks.
**Acceptance:**
- Stall rules have fire/not-fire fixtures.
- TTV math has unit tests.
- Handoff items all carry sources; missing ones say "Not found in CRM".
- The usage API rejects a wrong-workspace key (tenant test).
- Agent drafts go to Approvals.
- e2e demo passes.
**Demo:** Onboarding screen → "Pinecrest Health" stalled at "SSO setup (customer)" 12 days → Onboarding Manager draft check-in in Approvals → Adoption view shows 3 of 5 bought features never used, with cohort comparison.

## M7: Renewals, Revenue & Expansion
**Goal:** no surprise renewals. Renewal Radar 12 months out with deterministic confidence, Renewal Brief, forecast, ARR waterfall, invoice-level billing forecast, expansion pipeline, money at risk.
**Spec:** §6H1, H2, H3, H5, §6E8 Renewal Manager, §6E9 Expansion Finder, §6L1 Revenue & risk home (money at risk 30/90, forecast, coverage, team load), §6D Money (usage hitting paid limit, new team), §5 Renewals, Expansion, Revenue.
**Depends on:** M6.
**Deliverables:**
- **Models.** Renewal, ExpansionOpportunity (RevenueEvent exists from M2; extended rules).
- **Renewal confidence.** Deterministic (test-first): health band, trend, open critical signals, champion status, promises late, payment issues, notice deadline. Each factor is a reason with sources.
- **Renewal Radar** with team forecast. Each number opens into proof.
- **Renewal Manager agent** (90-day plan, talk track, outreach draft, next step with a date).
- **Renewal Brief.** A Document of kind RENEWAL_BRIEF, with locked metrics and narrative.
- **Expansion.**
  - Signals: limit hits, new users/teams, fast growth, stated goals.
  - ExpansionOpportunity with a **deterministic estimate labelled "Estimate"** (method shown).
  - Expansion Finder draft.
  - CRM export/sync via the write-back gate.
- **Revenue view.** ARR waterfall (new/expansion/contraction/churn), invoice-level billing forecast from billing cycles, money at risk next 30/90 days, coverage (accounts with no touch in N days), team load.
- **OutcomeRecord checkpoints** for RENEWED/EXPANDED/CONTRACTED/CHURNED.
**Acceptance:**
- Confidence and estimate unit tests.
- Waterfall reconciles: opening + movements = closing ARR (test on seed).
- Every forecast number links to proof.
- All money is hidden without `canViewRevenue` (test).
- No LLM output feeds any money/confidence field (forbidden-numeric test).
- e2e demo passes.
**Demo:** Renewals → next 90 days → "Northgate Freight", one of seven renewals tied at the lowest confidence (70%), with its reasons → open the Renewal Brief → approve the Renewal Manager outreach → Revenue → waterfall + $ at risk next 90 days → Expansion → "Copperleaf Studios" seat-limit opportunity "Estimate: $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription)".

## M8: Plays Engine
**Goal:** repeat jobs that actually run, safely. 15 seeded plays, simple builder with safety check, play results, Outreach + Digital CSM (limited), auto-send enablement, campaigns.
**Spec:** §6I1–I4, §6E11 Outreach, §6E12 Digital CSM (limited form per §8), §6J2 Campaigns, §6J4 (enable auto-send per play), §6N1 per-step-per-tier levels, §6F4 notes can trigger a play, §6G3 handoff play, §6O1 (setup proposes plays), §5 Plays.
**Depends on:** M7.
**Deliverables:**
- **Models.** Play, PlayVersion, PlayRun, PlayStepRun, Campaign, CampaignRecipient, VoiceSample.
- **PlayDefinition schema.** Trigger (signal/event/schedule/segment entry/note tag), conditions, branches (tier, health, ARR, renewal date), steps (notify / task / draft / send / update / escalate) with an approval level per tier.
- **Runner.** Idempotent entry, waits, approvals, exits.
- **Safety check (test-first).** Refuses a play that does nothing, has missing settings, a step without a handler, or a trigger nobody can detect.
- **The 15 seeded plays** as DRAFT: Health Risk, Renewal Risk, Renewal Window (90/60/30), Onboarding Stall, New Customer Handoff, Champion Loss, Adoption Drop, Expansion Opportunity, Payment Failed, Support Escalation / SLA Breach, Promise Late, QBR Due, Engagement Loss / Re-engagement, Cancellation Save, Business Review Follow-up.
  Champion Loss / Promise Late / QBR Due / Business Review Follow-up publish only once their triggers' detectors exist (the safety check enforces it; they publish in M9/M10).
- **Builder UI.** Plus "describe the play in plain words" (deep-tier LLM → PlayDefinition draft → Zod → safety check → human review).
- **Play results.** Entered, actions, replies, saves, revenue; dead plays visible; kill.
- **Agents.**
  - Outreach Agent with voice samples (approved real sent examples, per workspace).
  - Digital CSM: long-tail safe steps, with hand-off rules for risk/anger/pricing/legal/opportunity.
- **Auto-send.** Admin-only per play, master switch, all guards.
- **Campaigns.** Segment audience, simple editor, one approval per campaign, schedule, pacing, delivered/open/click/bounce via email provider webhooks, unsubscribe link + suppression honoured.
- **Setup wizard.** Adds the "proposed plays" step.
**Acceptance:**
- Safety-check unit tests (each refusal reason).
- A sensitive draft never auto-sends even with auto-send on (test).
- Every guard holds and routes to Approvals (integration test).
- An unsubscribed contact never receives (test).
- Play entry is idempotent.
- The 15 plays exist; those publishable in M8 pass the safety check; the rest show the exact missing detector.
- e2e: publish Payment Failed play for long-tail with auto-send → webhook → guarded send or hold, visible in play results.
**Demo:** Plays → inspect Health Risk play → try publishing a broken copy → refusal with plain reasons → publish Payment Failed for long-tail with auto-send → trigger → one account sends, one is held (contact emailed 2 days ago) and appears in Approvals → Play results.

## M9: Conversations, Inbox, Promises & Sentiment
**Goal:** calls/tickets/email read for risk, goals, competitors and promises in the core. Inbox with drafted replies. Promise Tracker. Sentiment & themes.
**Spec:** §6J1 Inbox, §6H4 Promise Tracker, §6K5 Sentiment & themes, §6D People (champion silent/bounced/left/new DM, email engagement), Support (repeat, angry, export/cancel), Calls & email (all), Promises, §6E1 Watcher (full), §6E3 Champion Guard, §6E6 Support Risk, §6E7 Promise Keeper, §6B Zendesk, Freshdesk, Google/Microsoft email, §5 Inbox.
**Depends on:** M8.
**Deliverables:**
- **Models.** Extraction (if not already created in M4), Promise, InboxItem.
- **Connectors.** Zendesk, Freshdesk, Gmail/Graph email adapters (read-only; "Draft in mailbox" only with write-back).
- **Watcher.** Full extraction across messages/tickets/transcripts, with golden fixtures for every kind (CI replay + `pnpm eval` live report).
- **Text-based signal rules.** Competitor, budget, cancel/export, complaint repeated, renewal concern, angry sentiment, no reply to important follow-up, goal stated (→ Goal).
- **People rules.** Champion silent/bounced/left, new DM, email engagement stops.
- **Inbox.** Inbound email/ticket → InboxItem on the right account (domain/contact matching; unmatched queue). Intent + sentiment, drafted reply to what was actually said (Support Risk Agent). Sensitive intent forces human.
- **Promise Tracker.** Extracted + manual, owner + due, late first. Promise Keeper chases internally. Promise Late play publishable.
- **Champion Guard.** Next best contact + draft intro. Champion Loss play publishable.
- **Sentiment & themes.** Per account and portfolio, with quotes as proof. Sentiment pillar now fed by real extractions.
**Acceptance:**
- Quote-substring validation drops invented quotes (test).
- Golden replay tests pass for every extraction kind.
- A live eval report is in the log, or explicitly DEFERRED if no key.
- An inbound "how do I cancel" never auto-replies (test).
- Unmatched email never lands on a wrong account (test).
- Late promises sort first.
- Every theme shows ≥ 1 quote with a source link.
**Demo:** Inbox → angry repeat-problem email from "Halden Retail" → intent "complaint", sentiment negative, quote highlighted → drafted reply references their actual ticket numbers → Promise Tracker shows "CSV export fix by Oct 24" (late, from a call) → Champion Guard flags "Maya Ortiz bounced" at Brightwell with suggested next contact.

## M10: Meetings, QBR, Success Plans & Portal
**Goal:** meeting prep in minutes, call summaries into the account, auto QBR from real numbers, shared success plans + customer portal, simple surveys.
**Spec:** §6K1 pre-call brief, §6K2 call summaries, §6K3 auto QBR, §6K4 surveys, §6J5 Customer Portal & Docs (launch scope), §6E10 Meeting & QBR Agent, §6B Google/Microsoft calendar, Fireflies/Gong/Zoom, §5 Meetings & QBRs, Success Plans & Docs, Customers (Portal).
**Depends on:** M9.
**Deliverables:**
- **Models.** Meeting, MeetingAttendee, CallTranscript (if not earlier), SuccessPlan, Goal, Document, Survey, SurveyResponse, PortalAccess.
- **Connectors.** Calendar adapters; Fireflies/Gong/Zoom transcript adapters, plus transcript upload.
- **Meetings.**
  - Pre-call brief generated before each meeting (job at T-30min and on demand): health + proof, last conversations, open tickets/promises, renewal, suggested questions.
  - Call summary + decisions + action items (→ Tasks with owners) + risks/goals/promises (→ Extraction pipeline).
- **QBR.** Pick account + period → locked computed metrics + narrative with `{{metric}}` placeholders. A human edits the story, never the numbers. Charts only where data exists. Export to PDF.
- **Success Plans.** Goals, milestones, progress; share to portal.
- **Portal.** Magic-link access per contact; plan, goals, progress, documents, reviews; read-mostly (customer can comment/mark goal progress? see Q-22).
- **Surveys.** NPS/CSAT/CES at journey moments (after onboarding complete, after ticket close, before renewal); responses feed Sentiment + Relationship pillars and can trigger plays. QBR Due and Business Review Follow-up plays become publishable.
- Today now shows meetings with "brief ready".
**Acceptance:**
- No number in a QBR narrative is free text (placeholder validator test).
- Portal tokens are scoped to one account (tenant + account isolation test); a revoked token fails.
- A survey response changes the pillar with a reason pointing at the response.
- Brief generation is idempotent per meeting.
- e2e demo passes.
**Demo:** Today → "Brightwell sync at 2pm — brief ready" → open brief → after the meeting, upload transcript → summary + 3 action items as tasks + a new promise → Generate QBR for Q3 → edit narrative → share to portal → open portal as the customer contact via magic link.

## M11: Ask AI, Reports & Outcome Ledger
**Goal:** proof of value. "Did It Work?" ledger in money, AI accuracy, pre-made leader reports + weekly Leader Reporter, Ask AI copilot with sources, file Q&A and confirmed actions.
**Spec:** §6L2 reports, §6L3 outcome ledger, §6L4 AI accuracy, §6H6 save record, §6E13 Leader Reporter, §6E14 / §6M1–M3 Ask AI (incl. voice + file upload, confirmed bulk actions), §5 Reports, Ask AI.
**Depends on:** M10.
**Deliverables:**
- **Models.** ReportSnapshot, AskThread, AskMessage.
- **Outcome Ledger.**
  - 30/90-day checkpoints complete. Ledger view per account / play / agent / signal.
  - The sentence "In 90 days it flagged N risks, the team acted on A, R recovered or renewed, worth $X" is computed.
  - Save record links each save/win to its signal and action.
- **AI accuracy view.** True/false alarms, CSM acceptance rate per agent/signal; "cry wolf" signals listed with tune/kill actions.
- **Pre-made reports.** Portfolio health trend, adoption, onboarding TTV, renewal outcomes, expansion found, support risk, team activity vs outcomes. Filters, no builder.
- **Leader Reporter.** Weekly digest (in-app + email to internal users + Slack).
- **Ask AI.**
  - Tool-using agent over scoped read-tools (accounts, people, calls, tickets, contracts, documents, signals, health); every answer cites tool results.
  - Numbers in answers must appear in tool output (validator).
  - "I cannot see a contract for this account" behaviour.
  - File upload (contract/transcript) Q&A after scan.
  - Voice input per Q-11.
  - Confirmed actions: shows the exact change list (e.g. 40 accounts → Renewal play), waits for yes, executes via the same services + audit.
**Acceptance:**
- Ledger math unit tests.
- The ledger reconciles with OutcomeRecords.
- An Ask AI answer with no citation is not rendered (test).
- A number not in tool output is rejected (test).
- Bulk action without confirmation does nothing (test).
- Ask AI cannot read another workspace (tenant test via tools).
- Reports respect `canViewRevenue`.
- e2e demo passes.
**Demo:** Ask "Which accounts mentioned a competitor this month, and what did they say?" → answer with quotes + links → "Move these accounts to the Renewal Risk play" → confirmation list → yes → Outcome Ledger → 90-day sentence with $ → AI accuracy → a noisy signal killed.

## M12: Hardening & Deploy
**Goal:** pilot-ready. Security, performance, data controls, observability, deploy pipeline, docs, full regression.
**Spec:** §6N2 (audit completeness), §6N3, §6N4, §6N6 (security path honest), §6N7 delete/export, §6O (setup end-to-end), §11 (pilot measurement needs: usage of Today/Approvals instrumentation), CLAUDE.md rules 1–9 audit.
**Depends on:** M11.
**Deliverables:**
- **Data controls.** Workspace export (ZIP) + deletion with grace period and purge job; DPA-ready data map doc.
- **Security review.** Tenant suite across every model + action (enumeration test), RBAC matrix full test, rate limiting on auth/webhooks/portal, CSP + security headers, dependency audit, secret scan, backup/restore runbook + tested restore, encryption-at-rest configuration documented.
- **Rule 8 verification.** AI provider data terms recorded (Q-19).
- **Performance.** Query-budget tests across list/360 screens; nightly run on a synthetic 2,000-account workspace within a documented time budget.
- **Observability.** Structured logs (redacted), job dashboards (Bull Board, Admin-only), error tracking via env-configured DSN (Q-20), and product instrumentation for §11 pilot metrics (Today/Approvals opens per CSM per week; flag acceptance rate).
- **Deploy.** Production Dockerfile(s) for web + worker, migrations on deploy, environment checklist, deploy target per Q-13, staging environment, smoke tests.
- **Docs and regression.** Admin guide, setup guide, security overview (no claims of certificates not held); full e2e regression across all demo scripts.
**Acceptance:**
- Every CLAUDE.md rule has an automated check listed with its test name.
- Export → re-import into a scratch workspace round-trips counts.
- Deletion purges all [W] rows (test).
- Restore drill documented with timestamps.
- 2,000-account nightly within budget.
- Staging deploy smoke passes.
- Full e2e green.
**Demo:** fresh staging workspace → setup wizard with CSV + Stripe test → day-1 Today queue → nightly run → Admin exports data → requests deletion → purge after grace (time-travelled in test).

---

## Spec → module → milestone traceability

Every spec feature appears below. "M4→M9" means started in the first milestone and completed in the second.

| Spec | Feature | Module(s) | Milestone |
|---|---|---|---|
| §4 | Daily loop: nightly re-read, update health, raise signals, prepare tomorrow | signals, health, today, integrations, agents | M3 (pipeline) → M4 (today/agents) → M5 (sync) |
| §5 | Today | today | M4 |
| §5 | Approvals | approvals, outbound | M4 |
| §5 | Accounts | accounts, segments | M2 |
| §5 | Account 360 | accounts, contacts, billing, usage, support, conversations, notes, tasks | M2 (+ tabs grow M3–M10) |
| §5 | Health | health | M3 |
| §5 | Onboarding | onboarding | M6 |
| §5 | Renewals | renewals | M7 |
| §5 | Expansion | expansion | M7 |
| §5 | Plays | plays | M8 |
| §5 | Inbox | inbox | M9 |
| §5 | Meetings & QBRs | meetings, success-plans | M10 |
| §5 | Success Plans & Docs | success-plans | M10 |
| §5 | Revenue | revenue | M7 |
| §5 | Reports | reports | M11 |
| §5 | Ask AI | ask-ai | M11 |
| §5 | Customers (Portal) | portal | M10 |
| §5 | Settings | settings, integrations, health, plays, approvals | M1 → M12 |
| §6A1 | Account Graph | accounts, integrations (ExternalRef) | M2 → M5 |
| §6A2 | People & stakeholder map | contacts | M2 |
| §6A3 | Contract & commercial record | billing | M2 |
| §6A4 | Full timeline | accounts | M2 (sources added as they arrive) |
| §6A5 | Missing-data helper | accounts | M2 |
| §6A6 | Data quality checker (+ safe bulk fixes) | accounts | M2 |
| §6B | CSV import | accounts, integrations | M2 |
| §6B | HubSpot, Salesforce | integrations | M5 |
| §6B | Stripe, Chargebee | integrations, billing | M5 |
| §6B | Slack | integrations, approvals | M5 |
| §6B | Segment / Usage API, Mixpanel, Amplitude | integrations, usage | M6 |
| §6B | Zendesk, Freshdesk | integrations, support | M9 |
| §6B | Google/Microsoft email | integrations, conversations | M9 |
| §6B | Google/Microsoft calendar | integrations, meetings | M10 |
| §6B | Fireflies/Gong/Zoom transcripts | integrations, meetings, conversations | M10 |
| §6B | Read-only default, write-back toggle, sync status in plain words | integrations | M5 |
| §6B | Phase 2 set | — (adapter seam) | out of scope |
| §6C1 | Health in 6 parts | health | M3 |
| §6C2 | "Why" behind every score | health | M3 (+ narrative M4) |
| §6C3 | Own normal + cohort | health, usage | M3 |
| §6C4 | AI proposes first health model (back-test) | health | M3 (deterministic proposal) → M5 (in setup wizard) |
| §6C5 | CSM Pulse | health | M3 |
| §6C6 | Health history & back-testing | health | M3 |
| §6C7 | Risk levels with named reason | health | M3 |
| §6D | Usage signals | signals | M3 (+ onboarding stall M6) |
| §6D | People signals | signals, contacts | M3 (no meeting in X days, structured) → M9 (silent/bounced/left/new DM, email engagement) |
| §6D | Support signals | signals, support | M3 (age, escalation) → M9 (repeat, angry, export/cancel) |
| §6D | Calls & email signals | signals, conversations | M9 |
| §6D | Money signals | signals, billing | M3 (payment, contract ending) → M7 (paid limit, new team) |
| §6D | Promise signals | promises, signals | M9 |
| §6D | Outside signals (manual/CSV, dated) | signals | M2 (import) → M3 |
| §6D | Each signal: meaning, detection, lead time, false alarm | signals | M3 |
| §6E1 | Watcher | agents, conversations, signals | M4 (basic) → M9 (full) |
| §6E2 | Health Analyst | agents, health | M4 |
| §6E3 | Champion Guard | agents, contacts | M9 |
| §6E4 | Onboarding Manager | agents, onboarding | M6 |
| §6E5 | Adoption Coach | agents, usage | M6 |
| §6E6 | Support Risk Agent | agents, support, inbox | M9 |
| §6E7 | Promise Keeper | agents, promises | M9 |
| §6E8 | Renewal Manager | agents, renewals | M7 |
| §6E9 | Expansion Finder | agents, expansion | M7 |
| §6E10 | Meeting & QBR Agent | agents, meetings, success-plans | M10 |
| §6E11 | Outreach Agent | agents, outbound, plays | M4 (basic, D-30) → M8 |
| §6E12 | Digital CSM (limited form) | agents, plays | M8 |
| §6E13 | Leader Reporter | agents, reports | M11 |
| §6E14 | Ask AI | ask-ai | M11 |
| §6E | Agent shows what it read/decided/did + past accuracy | agents, outcomes | M4 → M11 |
| §6E | Custom agents | — (AgentDefinition.isCustom seam) | Phase 2 |
| §6F1 | Today queue ranked by money + urgency | today | M4 |
| §6F2 | Approvals queue | approvals | M4 |
| §6F3 | Tasks + overdue escalation | tasks | M2 → M4 |
| §6F4 | Notes (templates, tags, mentions, trigger play) | notes, plays | M2 → M8 |
| §6F5 | Segments | segments | M2 |
| §6G1 | Onboarding plans | onboarding | M6 |
| §6G2 | Time-to-value tracking | onboarding | M6 |
| §6G3 | Handoff from Sales | onboarding, plays | M6 → M8 (play) |
| §6G4 | Adoption view | usage, onboarding | M6 |
| §6H1 | Renewal Radar & forecast | renewals, revenue | M7 |
| §6H2 | Renewal Brief | renewals, success-plans (Document) | M7 |
| §6H3 | Expansion pipeline + CRM export | expansion, integrations | M7 |
| §6H4 | Promise Tracker | promises | M9 |
| §6H5 | Revenue view (ARR waterfall, invoice forecast) | revenue | M7 |
| §6H6 | Save record | outcomes | M11 |
| §6I1 | 15 plays ready | plays | M8 (4 publish in M9/M10) |
| §6I2 | Simple builder + describe in plain words | plays | M8 |
| §6I3 | Safety check before publishing | plays | M8 |
| §6I4 | Play results | plays, outcomes | M8 |
| §6J1 | Inbox | inbox, conversations | M9 |
| §6J2 | Campaigns to a segment | campaigns, outbound | M8 |
| §6J3 | Slack | integrations, approvals | M5 |
| §6J4 | Auto-send guards | outbound | M4 (enforced) → M8 (enabled) |
| §6J5 | Customer Portal & Docs (launch scope) | portal, success-plans | M10 |
| §6K1 | Pre-call brief | meetings | M10 |
| §6K2 | Call summaries | meetings, conversations | M10 |
| §6K3 | Auto business review (QBR) | success-plans, meetings | M10 |
| §6K4 | Surveys | surveys | M10 |
| §6K5 | Sentiment & themes | conversations | M9 |
| §6L1 | Revenue & risk home | revenue | M7 |
| §6L2 | Pre-made reports | reports | M11 |
| §6L3 | Outcome ledger | outcomes | M3 (records) → M4/M7 (checkpoints) → M11 (views) |
| §6L4 | AI accuracy view | outcomes, agents, signals | M11 |
| §6M1 | Ask across everything, cited, no invention | ask-ai | M11 |
| §6M2 | Voice + file upload | ask-ai, storage | M11 |
| §6M3 | Confirmed actions (incl. bulk) | ask-ai, approvals | M11 |
| §6N1 | Approval levels per step per account type | approvals, plays | M4 → M8 |
| §6N2 | Full audit trail, exportable | audit | M1 → M4 |
| §6N3 | Tenant isolation + field-level protection | lib/db, billing | M1 → M2 |
| §6N4 | Never trains shared models | lib/ai | M1 (design) → M12 (verified) |
| §6N5 | Roles & permissions + revenue permission | settings, lib/auth | M1 |
| §6N6 | Security path (honest) | docs | M12 |
| §6N7 | Delete/export | settings | M12 |
| §6O1 | AI-proposed setup flow | integrations, health, segments, plays | M5 → M8 |
| §6O2–O3 | Targets / no implementation fee | — (not features; pilot measures) | M12 instrumentation |
| §9 | Simple data model | all | ARCHITECTURE §3 |
| §10.1 | Product name as config | lib/config | M1 |
| §10.2 | Price as config | lib/config | M1 |
| §11 | V1 judging metrics (instrumentation) | reports | M12 |
