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
