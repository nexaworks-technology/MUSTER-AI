# SEED DATA: demo workspace design

**Seed only.** Everything here is fictional. It is loaded by `pnpm db:seed` (`prisma/seed/`) into dev, test and demo databases. It is
never imported by production code paths (Rule 6). `pnpm db:seed` refuses to run when `NODE_ENV=production` unless
`ALLOW_DEMO_SEED=true` is set for a dedicated demo environment.

## 1. Determinism

- **PRNG.** One seeded generator (`mulberry32`, seed `20261102`) is passed explicitly to every generator function. Nothing uses `Math.random`.
- **Dates.** Every date is relative to `SEED_TODAY`, default `2026-11-02` (a Monday), overridable via env for time-travel tests.
  The seed stores absolute timestamps computed from it, all at 09:00 in the workspace time zone unless stated.
- **Ids.** These are stable: `cuid`-shaped strings derived from `sha1(seedKey)` for every story record (e.g. `acc_brightwell`), so tests and
  golden fixtures can reference them.
- **Idempotency.** Re-running the seed wipes and recreates only the demo workspace (by slug `larkspur-demo`).
- **Phasing.** Seed grows with milestones. Each milestone adds the records its features need, and the full design below is the end state.
  `prisma/seed/index.ts` loads sections in dependency order: tenancy → accounts/people → commercial → usage → support/conversations →
  meetings/transcripts → onboarding → historical outcomes → surveys. Derived data (health snapshots, signals, extractions, agent runs) is
  **never seeded directly**. It is produced by running the real nightly pipeline (`pnpm jobs:nightly --workspace larkspur-demo`)
  and, for extractions, by the `RecordedProvider` replaying recorded fixture responses in test/demo mode only. That way every screen shows output of real code.
- **Fictional domains.** All email domains use the reserved `.test` TLD (e.g. `brightwell-logistics.test`), so nothing can reach a real inbox. The dev email transport is log-only anyway.

## 2. The demo workspace (our customer)

| Field | Value |
|---|---|
| Workspace | **Larkspur Analytics** (slug `larkspur-demo`) |
| What they sell | "Larkspur", an operations reporting platform for logistics, retail and services companies |
| Time zone / currency | America/New_York · USD |
| Plans | Starter, Growth, Scale, Enterprise (annual contracts; Starter also monthly) |
| Feature catalog (key ★) | dashboards ★, scheduled_reports ★, alerts ★, csv_export, api_access, data_connectors ★, sso, audit_trail |
| Tier rules (INTERP-3) | ARR ≥ $50k High-touch · $10k–50k Mid-touch · < $10k Long-tail |

### Users (dev-only credentials defined in `prisma/seed/users.ts`, never in docs)

| Name | Email | Role | canViewRevenue | Book |
|---|---|---|---|---|
| Priya Raman | admin@larkspur.test | ADMIN | ✓ | ALL |
| Dana Whitfield | dana@larkspur.test | CS_LEADER | ✓ | ALL |
| Leo Marsh | leo@larkspur.test | CSM | ✗ | OWN (high-touch + some mid) |
| Aisha Bello | aisha@larkspur.test | CSM | ✗ | OWN (mid + long-tail pool) |
| Tom Becker | tom@larkspur.test | VIEWER | ✗ | ALL (read-only) |

A second workspace, **"Ferngrove Software"** (slug `ferngrove-test`), with 3 accounts and 1 Admin, exists **only in the test seed**.
It is the "other tenant" for isolation tests and e2e "cannot see" checks.

## 3. Account portfolio (60 active)

- **Tiers.** 10 high-touch (ARR $55k–$240k), 20 mid-touch ($12k–$48k), 30 long-tail ($1.2k–$9.6k). Total active ARR is ≈ $1.9M.
- **Owners.** Leo owns 10 high-touch + 6 mid. Aisha owns 14 mid. The 30 long-tail accounts have **no human owner**: they are the Digital CSM pool, and `ownerId` is null by design. Missing-owner prompts are suppressed for long-tail via `WorkspaceSettings`.
- **Industries.** Logistics, retail, healthcare, professional services, fitness, legal, manufacturing. Employee bands: 1–50, 51–200, 201–1000, 1000+.
- **Lifecycle.** 8 ONBOARDING (started 10–75 days ago), 40 ADOPTING/MATURE, 12 RENEWING (renewal ≤ 90 days).
- **Renewal dates** spread over the next 12 months, roughly 5 per month, with 2 high-touch renewals in each quarter.
  Three contracts are deliberately missing data, to exercise the missing-data helper and Rule 4:
  - "Fairhaven Dental Group": no contract on file.
  - "Kestrel Robotics": contract with no renewal date.
  - "Bluefin Charters": no owner and no key contact (a mid-touch account, so it is prompted).
- **Contacts.** 3–9 per high-touch, 2–5 per mid, 1–2 per long-tail. Every high-touch and mid account has a CHAMPION and a DECISION_MAKER role,
  except the planted gaps: "Glenmore Foods" has no decision maker known.

### Story accounts (named, hand-authored; every screen and agent has something true to show)

| Account | Tier / owner | Story (what is planted) | Shows up in |
|---|---|---|---|
| **Brightwell Logistics** | High · Leo · $186k ARR · renewal in 118 days | <ul><li>Weekly active users fell from ~41 to ~17 over the last 5 weeks; the `scheduled_reports` key feature stopped 19 days ago.</li><li>Champion **Maya Ortiz** (Head of Ops): last reply 44 days ago, email bounced 6 days ago, CRM title changed to "Former employee". New contact **Ben Okafor** (Director of Finance) joined meetings recently.</li><li>Competitor **"Tallyfield"** is mentioned on a call 12 days ago: *"Our CFO asked us to look at Tallyfield before renewal."*</li><li>Meeting **today at 14:00**, with a transcript fixture for after the call. Portal demo contact: Ben Okafor.</li></ul> | M3 At Risk + reasons, M4 Health Analyst, M9 Champion Guard, competitor signal, M10 brief/summary/QBR/portal, M11 Ask AI |
| **Pinecrest Health** | Mid · Aisha · $28k · onboarding day 33 | <ul><li>Onboarding plan stuck at step "SSO setup" (owner: customer, IT contact Raj Patel), overdue 12 days.</li><li>Only 3 of 15 seats active. `data_connectors` never used.</li></ul> | M6 stall, Onboarding Manager, Adoption Coach |
| **Northgate Freight** | High · Leo · $142k · renewal in **41 days** (notice period 30 days) | <ul><li>Health Watch trending down. One late invoice.</li><li>Renewal concern on a call: *"We need to see the API limits fixed before we sign again."*</li><li>A 2nd open promise is late. Expected deterministic confidence ≈ 38% (fixture asserts the band, not the exact number).</li></ul> | M7 Renewal Radar, Brief, Renewal Manager |
| **Copperleaf Studios** | Mid · Aisha · $36k · 40 seats bought | <ul><li>52 active users for the last 3 weeks (12 over), and new users from a "Design" team since 20 days ago.</li><li>Stated goal on a call: *"We want every studio lead on Larkspur by Q1."*</li></ul> | M7 expansion signal + estimate "12 seats × $900 list = $10,800 ARR (estimate)", Expansion Finder |
| **Halden Retail** | Mid · Leo · $44k | <ul><li>3 tickets in 26 days about the same broken CSV export (one HIGH, escalated).</li><li>Latest inbound email is angry: *"This is the third time the export has failed during month-end. We are losing patience."*</li><li>On a call 31 days ago the CSM promised: *"Engineering will have the CSV export fix to you by October 24."* The promise is not done, so it is late.</li></ul> | M3 ticket age, M9 repeat problem, angry sentiment, Inbox draft, Promise Tracker (late first), Promise Keeper |
| **Quillmark Legal** | Mid · Aisha · $19k | Ticket: *"How do I export all our data before we cancel at the end of the term?"* | M9 cancel/export signal (CRITICAL), sensitive → human only; Cancellation Save play |
| **Sundial Fitness** | Long-tail · none · $2.4k | Card payment failed 3 days ago (failureCount 2). Contact timezone known. | M3 payment signal, M5 Stripe webhook demo, M8 Payment Failed play (auto-send path) |
| **Orchard Lane Bakery Supply** | Long-tail · none · $1.8k | Payment failed yesterday. The contact was emailed by another play **2 days ago**. | M8 guard: held (contact emailed < 3 days) → Approvals |
| **Marlow & Finch** | High · Leo · $98k | Goal stated on a call: *"Our goal is to cut month-end close to 3 days."* Healthy. QBR due this month. | M9 goal extraction, M10 QBR draft + success plan, QBR Due play |
| **Tidewater Clinics** | High · Leo · $121k | Healthy by score, but Leo's Pulse is **"Worried"** (comment: "New VP is skeptical"). | M3 score/CSM disagreement |
| **Ashgrove Manufacturing** | Mid · Aisha · $22k | **Healthy by score** (96.9; the closed, un-escalated migration spike is outside the spec's Support inputs, so it does not lower Support). Aisha's Pulse is **"Actually fine"** (comment: "Spike was one migration, resolved"), which agrees with the score, so it is not a disagreement. *Corrected 2026-11-03 (Q-45).* | M3 Pulse agreeing with the score; the disagreement demo is Tidewater plus a live Worried Pulse |
| **Redfern Outdoor** | Long-tail · none · $3.6k | No logins in 24 days; previously weekly. | Engagement loss signal, Re-engagement play, Digital CSM |
| **Glenmore Foods** | Mid · Aisha · $16k | No decision maker known; no meeting in 63 days. | Relationship gap, "no meeting in X days" |
| **Fairhaven Dental Group / Kestrel Robotics / Bluefin Charters** | various | Missing contract / renewal date / owner (see above) | M2 missing-data helper; health shows "No contract on file" and is **not** lowered |
| **Silverline Couriers** | Mid · Leo · $31k | Data-quality: duplicate account "Silverline Couriers Inc." with an overlapping domain, plus 2 duplicate contacts. | M2 data-quality checker (fix only on confirm) |
| **Outside signal** | "Brightwell Logistics" | CSV row: "Acquired by Haverford Group", public URL `https://news.example.test/haverford-brightwell`, dated 2026-10-20 | M3 OUTSIDE signal (dated, never framed as fresh) |

## 4. Usage time series

- **UsageDaily** (account level): **365 days** for every active account, so baselines and back-tests have history.
  Generator: account base level (by seats and tier) × weekday seasonality (weekends 25%) × slow trend × noise (±8%).
  Planted shapes are applied on top: Brightwell's drop, Copperleaf's growth, Redfern's stop, and Pinecrest's partial onboarding curve.
- **UserUsageDaily and FeatureUsageDaily:** last **90 days** (volume control), 1–60 users per account. Power users are the top 10% by events, with weekly stability.
  Brightwell's top power user (Maya Ortiz's external user id) goes to zero 40 days ago.
- **Seats and credits.** `seatsUsed` is taken from distinct active users over 28 days. Credits are used only by Scale/Enterprise accounts.

## 5. Support, conversations, meetings

- **Tickets.**
  - ~220 total over 180 days: 0–3 per account per month, with priority mix 60% NORMAL / 25% LOW / 12% HIGH / 3% URGENT.
  - Planted: Halden ×3 (repeat), Quillmark ×1 (cancel/export), Ashgrove ×6 in one week (migration spike, all closed), and Northgate 1 open HIGH aged 9 days.
- **Conversations and messages.**
  - ~600 email messages over 90 days (inbound and outbound) for high- and mid-touch accounts, with realistic reply gaps.
  - Brightwell: no reply from Maya after day −44, and a bounce event at day −6.
- **Meetings.** ~80 past meetings (30–45 min) over 180 days for high- and mid-touch accounts, plus 6 upcoming (incl. **Brightwell today 14:00** and Marlow & Finch on day +3).
- **Call transcripts.** 14 hand-written fixtures (1,200–2,500 words each) in `prisma/seed/fixtures/transcripts/`. Each planted line appears **verbatim** in its transcript, which golden extraction tests rely on:

| Transcript | Planted lines (verbatim) | Expected extraction kinds |
|---|---|---|
| brightwell-2026-10-21 | "Our CFO asked us to look at Tallyfield before renewal." · "Honestly the scheduled reports have been flaky since September." | COMPETITOR, RENEWAL_CONCERN, COMPLAINT, SENTIMENT(NEGATIVE) |
| brightwell-2026-11-02 (post-call, used in M10 demo) | "Ben will own the rollout from finance now that Maya has left." · "Can you send the usage numbers by Friday?" · "We'll fix the scheduled report failures and confirm by November 13." | DECISION, ACTION_ITEM, PROMISE(due 2026-11-13) |
| halden-2026-10-02 | "Engineering will have the CSV export fix to you by October 24." | PROMISE(due 2026-10-24) |
| northgate-2026-10-15 | "We need to see the API limits fixed before we sign again." · "Budget is tight next year, so every tool is being reviewed." | RENEWAL_CONCERN, BUDGET_CONCERN |
| copperleaf-2026-10-19 | "We want every studio lead on Larkspur by Q1." | GOAL |
| marlow-finch-2026-10-08 | "Our goal is to cut month-end close to 3 days." | GOAL, SENTIMENT(POSITIVE) |
| 8 neutral transcripts | ordinary check-ins | **no** risk extractions (false-positive fixtures) |

- **Inbound emails with plants:** Halden's angry email (verbatim above), Quillmark's cancel/export ticket, a positive Marlow & Finch email,
  and 3 neutral "how do I…" emails for intent classification negatives.

## 6. Commercial

- **Contracts.** One per active account (except Fairhaven), with value, seats, start/end, renewalDate, autoRenew, noticePeriodDays (30/60/90).
  Terms text is encrypted at seed time via the same crypto module.
- **Subscriptions and invoices.** Annual or monthly per plan, giving ~900 invoices over 24 months.
  - Planted failures: Sundial (FAILED ×2, 3 days ago), Orchard Lane (FAILED yesterday), Northgate (paid 21 days late, 2 months ago), and 2 random long-tail accounts with recovered failures.
- **RevenueEvents** (computed by the M2 rule from contracts/subscriptions, never hand-inserted):
  - NEW for all accounts;
  - 6 EXPANSION and 3 CONTRACTION in the last 12 months;
  - CHURN for the historical churned set.

## 7. Onboarding (8 accounts at different stalls)

| Account | Day | State |
|---|---|---|
| Pinecrest Health | 33 | Stalled: SSO setup (customer side) overdue 12d |
| Wrenfield Labs | 12 | On track |
| Ostara Home Goods | 47 | Stalled: no data connector connected (our side task done, customer never connected) |
| Cobalt Ridge Transit | 20 | Stalled: kickoff done, no logins in 9 days |
| Juniper Vet Partners | 61 | Value reached on day 38 (fast vs cohort median 52) |
| Lumen Freightworks | 75 | Value not reached, past target day 60 (late vs cohort) |
| Saltmarsh Media | 5 | Just started; Sales handoff has 2 stated goals and 1 promised integration from CRM deal notes |
| Ridgeback Security | 28 | On track, 1 step blocked with reason "waiting on legal review" |

Onboarding templates: "Mid-touch standard (60d)", "High-touch guided (90d)", "Long-tail self-serve (21d)", each with a measurable value definition
(e.g. "≥ 3 scheduled reports active and ≥ 60% seats active for 14 days").

**As seeded (M6, `prisma/seed/demo/onboarding.ts`).** The seed writes templates, plans, steps and goals only; every
status, stall reason, blocker and product-event completion comes from the seed's own nightly pass (the same code as
production). Steps due before today are marked done by the account owner (HUMAN) unless the story leaves them open;
on open plans a step with a product condition is left for the pass, which completes it from the seeded usage with the
proving row ids.

- Value definitions: Mid-touch = Data connectors used on 3 different days AND Scheduled reports used on 32 different
  days AND ≥ 40% of seats active on each of 10 weekdays in a row; High-touch = 4 key features used AND ≥ 60% of seats active on 10 weekdays in a row; Long-tail = 2
  key features used AND ≥ 2 active users on 5 weekdays in a row. Conditions count weekdays (B2B use drops at weekends).
- Story steps: Pinecrest leaves SSO open (customer step owned by Raj, due day 21 → 12 days overdue); Ostara leaves
  "Connect a data source" open (19 days overdue); Ridgeback has an extra "Security review" step blocked with
  "waiting on legal review"; Lumen's plan has a per-account target of day 60 on the 90-day High-touch template.
- **Seed-only history for time to value (D3):** completed plans started 300 days ago on adopted accounts, value reached
  on a fixed list of days per cohort, each with a real `UsageDaily` id as evidence — Mid-touch Growth 51-200:
  40, 45, 48, 50, 52, 55, 58, 62, 70 (cycled; median 52); Mid-touch Growth 201-1000: 14, 16, 18, 20; High-touch
  Scale: 55, 60, 62, 70, 80 (median 62, P75 70).
- Juniper Vet's plan is seeded open like the others; the seed's nightly pass finds value reached on **day 37** from
  its usage (the proving `UsageDaily`/`FeatureUsageDaily` rows are the evidence). §7's table says day 38: no
  threshold lands on 38 without reshaping the M3 usage stories, so the data-derived day 37 stands (M6-LOG,
  Q-58). The historical plans' evidence is the usage row of the recorded day (seed-only history, not re-derived).
- Goals: Saltmarsh has 2 stated goals and Pinecrest 1, sourced to the account (CRM deal notes). Saltmarsh's
  "1 promised integration" needs the Promise model (M9) and is not seeded in M6.
- Resulting states (asserted by `prisma/seed/__tests__/seed-onboarding.int.test.ts`): Pinecrest STALLED "SSO setup
  (customer) overdue 12 days"; Wrenfield ACTIVE; Ostara STALLED "Connect a data source (customer) overdue 19 days";
  Cobalt Ridge STALLED "No one has used the product for 9 days"; Juniper Vet COMPLETE (day 37 vs median 52); Lumen
  STALLED "Day 75 and value not reached yet…" (High-touch Scale cohort: the 201-1000 band has only 3 peers, so the
  cohort falls back to all High-touch Scale accounts and says so); Saltmarsh ACTIVE; Ridgeback ACTIVE.

## 8. Historical outcomes for back-testing (§6C4)

- **12 churned accounts** (lifecycle LOST, churned 1–14 months ago). They have full history in the 180 days before churn: usage, tickets, messages, invoices, stakeholder roles.
  - 9 show detectable decline 30–75 days before churn: usage drop (4), champion left (2), payment failures (1), and support escalation plus negative sentiment (2).
  - **3 are "silent churns"** with no detectable signal (budget cuts announced only at notice). This keeps the back-test honest: no model catches 12/12.
- **12 renewed accounts.** These are active accounts whose last renewal was 1–11 months ago. 10 were healthy throughout. **2 had a temporary dip**
  (one migration support spike, one seasonal usage dip) that a naive model flags. They are the false-alarm test cases.
- **Expected back-test result.** It is captured in the golden fixture `src/modules/health/__tests__/fixtures/backtest-seed.json`.
  Measured on the seed (the fixture asserts these exact numbers; nothing is tuned to a target, D-59): the default model catches **0 of 12** churns with 0 false alarms out of 12 renewals; the back-test proposal (Adoption 70 %, Healthy from 60, Watch from 55) catches **4 of 12, on average 28 days early, with 0 false alarms**. *Corrected 2026-11-03 (Q-43, Q-44); the earlier "8 of 12" was a design expectation, not a measurement.*
  If the engine changes, the fixture changes only with a written reason in the milestone log.

## 9. Surveys

- NPS: 70 responses over 6 months (scores 0–10, skewed positive). Brightwell's Ben Okafor gave a 4 with comment *"Reports keep failing at month-end."*
- CSAT after ticket close: ~120 responses. Halden's last 2 are 1/5.
- CES: 30 responses after onboarding milestones.

## 10. Plays, campaigns, outbound history

- The 15 seeded plays are created as DRAFT by the plays module's own seeding (M8). They are not hand-inserted rows.
- Outbound history: ~150 SENT OutboundMessages over 90 days, including the Orchard Lane email 2 days ago that triggers the 3-day guard.
- Suppression: one long-tail contact (Redfern Outdoor's secondary contact) is UNSUBSCRIBED.

## 11. What each milestone relies on (checklist for seed authors)

| Milestone | Needs from seed |
|---|---|
| M1 | Workspace, 5 users, the Ferngrove test tenant |
| M2 | Accounts, contacts, roles, contracts (with gaps), invoices, usage, tickets, messages, notes, duplicates, outside-signal CSV sample |
| M3 | 365d usage, historical churned/renewed sets, Pulse rows (Tidewater, Ashgrove) |
| M4 | Notes/tickets text for Watcher-basic; recorded AI responses for e2e |
| M5 | Stripe/HubSpot/Salesforce/Chargebee/Slack fixture payloads (recorded, fictional) |
| M6 | Onboarding accounts, templates, feature catalog, user/feature usage |
| M7 | Renewal spread, Northgate, Copperleaf, revenue history |
| M8 | Long-tail pool, Sundial, Orchard Lane, outbound history, suppression |
| M9 | Emails, tickets, transcripts with plants + neutral negatives |
| M10 | Meetings (today 14:00), transcripts, NPS/CSAT, Marlow & Finch QBR data, Ben Okafor portal contact |
| M11 | ≥ 90 days of OutcomeRecords produced by running the pipeline over seed history (time-travel script `pnpm seed:replay` runs nightly jobs for the last 90 days of SEED_TODAY) |
| M12 | Synthetic generator `pnpm seed:synthetic --accounts 2000` (perf only, separate workspace) |
