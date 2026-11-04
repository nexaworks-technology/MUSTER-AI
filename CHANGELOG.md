# Changelog

All notable user-facing changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Plays Engine: automated, repeatable play definitions with pre-publish safety checks in plain words, step-level approval resolver, runtime frequency caps, and version history.
- 15 Seeded Plays: 11 active plays (including Champion Loss, Payment Failed, Cancellation Save) and 4 dormant plays clearly labeled with their future milestone detectors (Promise Late, Engagement Loss, QBR Due, Business Review Follow-up).
- Guarded Auto-Send: Admin-only master switch with typed confirmation (`ENABLE AUTO-SEND`), executing approved actions through a verified proof path without altering the single send choke point.
- Outreach and Digital CSM agents: personalized outreach drafting citing telemetry and hand-off rules routing long-tail and risk accounts to human CSMs.
- Play Builder: conversational assistant in the AI team that drafts new play definitions subject to the identical hard pre-publish safety gate.
- Campaigns: segment-targeted email campaigns with Admin / CS Leader decision rights, rate-limited pacing, signed unsubscribe links, and Svix/Resend delivery webhook processing.
- Renewal Plan Adoption: one-click human adoption of AI-suggested renewal plans from the Renewal Brief into `Renewal.planSteps` with placeholder validation.
- Setup Wizard Proposed Plays: deterministic play recommendations tailored to connected integrations and account segments.
- Task completion acting as flag resolution (Q-48): completing a task linked to a signal marks the signal's outcome record as `ACTED`.

- Renewals: a radar of every renewal in the next year, lowest confidence first, with the reasons and the records behind
  each figure; your own forecast category (Commit, Best case, At risk) sits beside the computed band and a
  disagreement is flagged. Account 360 has Renewal and Expansion tabs; a past renewal shows what the forecast said.
- Renewal brief: locked figures read from the records (health by part, open risks, goals, expansion chance), each
  with its sources, and the Renewal Manager's plan and talk track, whose numbers are filled in by code. Its outreach
  waits in Approvals; its next step becomes a task.
- Revenue (needs revenue access): an ARR waterfall that reconciles to the contracts, money at risk, expected billing,
  coverage and team load. Without access, money reads "Restricted" everywhere.
- Expansion: accounts running out of seats or credits, a new team, fast growth or a stated seats goal, with an
  estimate worked out from the account's own subscription and its method shown (no price on file means no number).
  The Expansion Finder drafts a proof-led conversation to Approvals. Export to HubSpot or Salesforce goes through
  write-back: off by default, approval first.
- Outcomes: a flag later followed by a renewal, expansion, contraction or churn records it with the evidence, as
  attributed value, not proven cause.

- Onboarding: every new customer has a plan built from a template, with steps owned by us or the customer. A
  step is done only when a person marks it or the product itself shows it (with the usage days as proof).
  The Onboarding screen lists every account being onboarded, stalled first, with the likely blocker in plain
  words ("SSO setup (customer) overdue 12 days") and time to value against similar accounts. The account's
  Onboarding tab adds the Sales handoff, each item with its source and "Not found in CRM" where it is missing.
- Adoption (a tab beside Usage): "3 of 5 features in your plan have never been used", seats, power users and
  use against the account's own normal and similar accounts, every figure linked to the days behind it.
- Usage API: send product events to `/api/usage/v1/track`, `identify` or `batch` with a key made in Settings ›
  Integrations (shown once, rotatable), or through Segment. Events are folded into daily totals and not kept.
  Mixpanel and Amplitude connect there too.
- Onboarding Manager and Adoption Coach drafts: a check-in for a stalled step and a nudge about plan features not
  yet used wait in Approvals; nothing is sent without a person. A stalled plan also tells its owner in the bell.

- Integrations (Settings › Integrations, Admins): connect HubSpot, Salesforce, Stripe, Chargebee and Slack.
  Every connection reads only; each one shows when it last synced, what it added, updated or could not use,
  and any error in plain words. Run a sync now, test the connection, or disconnect (saved keys are deleted).
- Syncs run every night before health is scored. Running one twice changes nothing. When a CRM disagrees
  with a value already in NexaWorks, nothing is overwritten: the difference appears in Data quality as
  "Sources disagree" for a person to resolve.
- Payment failures from Stripe and Chargebee arrive in real time: the account's owner sees "Payment
  failed" in Today straight away, with the invoice as evidence.
- Write-back to HubSpot and Salesforce is off by default. An Admin can allow one field (account owner);
  every change then waits for an approval and is recorded in the audit trail.
- Slack: approvals, big signals and a morning digest arrive as direct messages to your team. Everyday
  approvals can be approved or rejected from Slack; sensitive ones (cancel, price, legal, security,
  complaint, escalation) show "Open in app to review" and can only be decided in the app.
- Settings › Data health: work that did not finish (syncs, events, background jobs), in plain words, with
  "Run again".
- Setup (/setup): five steps for a new workspace: connect, import (from an integration or CSV), tier bands
  and starter segments, the health model with its back-test, then go live.

- Sign in with email and password. Google sign-in appears when it is configured.
- Workspaces with roles: Admin, CS Leader, CSM and Viewer, plus a separate revenue-access permission and
  a per-member choice of which accounts they see.
- Settings › Users: invite people by email, accept invitations, change roles and access, and deactivate members.
- Settings › Workspace: workspace name, time zone and base currency.
- An audit trail of sign-ins, invitations and access changes that cannot be edited.
- Accounts: a searchable, sortable list of every account in your book, with tier, stage, owner, ARR,
  renewal date and last touch, filters, and inline edits for tier, stage and owner.
- Account 360: Overview, People (with champion), Usage (weekly active users chart with its data table),
  Tickets, Conversations, Contracts & billing, Tasks, Notes and a Timeline of everything that happened.
- Contracts, invoices and revenue movements, with money hidden from anyone without revenue access, and
  contract terms encrypted at rest. ARR, renewal date and tier follow the current contract.
- CSV import (Settings › Import) for accounts, contacts, contracts, invoices, usage, tickets and ticket
  messages: match columns, preview every row with plain-words errors, then confirm. Importing the same
  file again creates no duplicates. Downloadable templates.
- Tasks with owners and due dates, notes with templates and @mentions, and notifications.
- Saved segments: save the current account filters and reuse them.
- Missing-data questions: one short question at a time (renewal date, owner, champion), skippable for 7
  days, never blocking.
- Data quality (Settings › Data quality): finds duplicate accounts and contacts, messy or invalid emails
  and stale accounts. Safe fixes (merging duplicate contacts, tidying an email) apply only after you
  preview the exact changes and confirm, one at a time or all at once.
- Signed contract documents: upload and download them from Contracts & billing.
- Health with proof: every account gets a score from six parts (Adoption, Engagement, Support,
  Relationship, Commercial, Sentiment), each part opening into its reasons, the values and dates behind
  them, and links to the exact records (usage window, contact, ticket, invoice). A part with no data
  shows "Not enough data" and never lowers the score. The Health screen shows accounts by band, what
  moved today and this week with the reason, and a history chart per account.
- CSM Pulse: "Actually fine" or "Worried" (with a comment) on any account in your book. It counts as one
  input to Relationship and never silently overrides the numbers; when the two disagree, both are shown.
- Signals: 15 rules over usage, people, support, money and outside events, each explaining what it
  means, how it is detected, how early it appears and what makes it a false alarm. Signals open,
  update, resolve themselves when the condition clears, and can be acknowledged or marked as a false
  alarm (which stays quiet unless things get materially worse). Admins and CS Leaders tune thresholds in
  Settings › Signals. Outside events (acquisitions, leadership changes…) are added by hand or by CSV,
  always with a dated public source.
- Health model back-test (Settings › Health model): replays your own renewed and churned accounts using
  only what was known at the time, proposes a model in one sentence ("we would have flagged X of your
  last Y churns, on average N days early, with Z false alarms"), shows the runner-up, and lets you
  preview your own weights before saving them as a new version. Nothing changes until an Admin approves
  and activates a version; old scores keep the version they were made with.
- Health and signals refresh every night at 02:00 in the workspace's time zone, and right away after a
  Pulse, a payment change or a ticket escalation. "Recompute now" runs the same job on demand.
- Today: the page you land on after signing in. What needs you today, from your own accounts only:
  tasks due or overdue, new signals, approvals waiting for you and renewals in the next 90 days, ranked
  by account value × urgency with the reason on every item ("$142k ARR × overdue 2 days"). Without
  revenue access the order is the same and no value is shown. Meetings show "No calendar connected"
  until a calendar is.
- Approvals: every draft waiting for a human yes or no, with its reason and links to its proof.
  Approve, edit then approve (the edit is kept as a new version, the original is never overwritten), or
  reject with a note; approve or reject several at once after confirming the exact list. Anything about
  cancellation, pricing, legal, security, a complaint or an escalation is marked "Sensitive" and "Always
  human": it can never be sent automatically or approved in bulk.
- Draft check-in: from any open signal or ticket, write a check-in email (or let the AI draft one when AI
  is configured). It goes to Approvals; nothing reaches a customer until someone approves it, and every
  send passes the send checks (approved text, sources, unsubscribed or bounced addresses never emailed).
  Automatic sending stays off.
- Health Analyst: on an account's Health tab, the AI's top one or two risks or opportunities in plain
  words, each linked to the exact health reason or signal behind it, with the model's own confidence and
  a "What it read" link. Any number it writes must appear in a record it cites; anything uncited is never
  shown. Without an AI key the tab says "AI is not configured".
- Sentiment: customer ticket messages labelled by AI from verified quotes now feed the Sentiment part of
  health as data; the score itself stays a formula.
- Overdue tasks escalate to CS Leaders, who see them on their Today and in notifications.
- Settings › Audit: every human and AI decision, filterable by person or agent, action, target and date;
  Admins export CSV or JSON, and each export is itself recorded.
- Settings › AI team: each agent's job, model tier, prompt version and recent runs, with a switch for
  Admins. Each run shows what it read, what it decided and what it did, and a run that failed shows why
  and nothing of its output.
