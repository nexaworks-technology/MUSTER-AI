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
