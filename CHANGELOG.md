# Changelog

All notable user-facing changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
