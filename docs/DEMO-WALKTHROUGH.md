# Muster Demo — enriched demo workspace and feature walkthrough

Branch `demo/enriched-demo` (not merged). Walk date: **2026-11-21** (a Saturday), as of the seed run the same
morning. Everything here is fictional: `.test` domains only, no live connector call, no real customer.
Larkspur Analytics and Muster Proof were not touched: the demo lives in its own database (see "Where it runs").

## The three logins

All three use the demo seed password (`DEMO_PASSWORD` in `prisma/seed/users.ts`, the same pattern as the
Larkspur seed and the proof workspace; it is not repeated here).

| Login | Name | Role | Book | Revenue access |
|---|---|---|---|---|
| `admin@muster-demo.test` | Rhea Kapoor | Admin | All accounts (owns none) | Yes |
| `leader@muster-demo.test` | Marcus Hale | CS Leader | All accounts (owns 15, 14 active) | Yes |
| `csm@muster-demo.test` | Jonah Reyes | CSM | **Own accounts only (12)** | No |

Nine long-tail accounts have no owner (the Digital CSM pool).

## How to build it

```bash
pnpm exec tsx --env-file=<env file> scripts/demo-workspace.ts
```

- **Create-only**, the same pattern as `scripts/proof-workspace.ts`: it refuses if the `muster-demo` workspace or any
  of the three emails exists. A second run printed
  `Workspace "muster-demo" already exists; refusing (create-only).` and wrote nothing.
- `--skip-ai` builds everything without calling a model (used while tuning the inputs).
- All dates are relative to the moment the script runs; nothing goes stale.
- The workspace's monthly AI budget is set to 3M tokens (the product's own cap).

### Seeded through the product, not around it

The script writes **raw inputs only**, then runs the product's pipelines. It never writes a health score, signal,
approval, extraction, renewal, revenue event or AI text.

| Raw input | Written how | Source label on the records |
|---|---|---|
| Accounts, contacts, owners | `ingestBatch` (the connector ingest path) | HubSpot |
| A second CRM record for Ashby Mercer | `ingestBatch` → the real conflict rule opens 2 `DataQualityIssue`s | Salesforce |
| Customers, subscriptions, invoices | `ingestBatch` (matching by domain) | Stripe |
| Tickets (incl. the unmatched one) | `ingestBatch` → matched tickets + Inbox; the unknown requester → Unmatched | Zendesk |
| Emails (incl. the bounce) | `ingestBatch` → conversations + Inbox | Gmail |
| Meetings | `ingestBatch` | Google Calendar |
| Contracts (seats, value, renewal, notice) | raw rows (seat count is not in the normalized contract) | HubSpot |
| Daily usage (account, person, feature) | raw rows (seats-in-use is not in normalized usage) | Mixpanel |
| Stakeholder roles, contact status (left), ticket escalation flags | raw rows | — |
| CSM Pulses, notes, tasks, survey responses, onboarding plan, success plan | rows a person or the customer creates | Manual |

Pipelines run afterwards, all for this workspace only: the nightly signals + health pass **as of 28, 21, 14 and 7 days
ago and today** (so renewals entered their windows in the past and the 30-day trend has real points), the Watcher on
the story messages of the last 30 days, the nightly pass again, the outbox dispatcher (`dispatchOutbox` with an
in-process handler: plays on `signal.opened`, the Onboarding Manager on `onboarding.stalled`), the Champion Loss play
(published through `publishPlay`), Outreach check-ins on the two at-risk story accounts, the renewal, expansion and
onboarding sweeps, the Health Analyst on the scored story accounts, the QBR and pre-call brief, and the Leader
Reporter's weekly digest. Sweeps run in real time (a provider without the Batch API) so results land during the run.

**Product change on this branch:** one re-export in `src/modules/integrations/service.ts`
(`ingestBatch`, `IngestTarget`, `NormalizedKind`) so the script can use the ingest path through the module's public
surface instead of disabling the lint rule. No behaviour changed.

**AI used:** 56 agent runs, about 203k tokens, in the final workspace (Claude via the configured key). Three full
builds were run while tuning, so the session total is about three times that.

### Where it runs

The `.env` database is the live connector-proof stack (production-mode Docker worker with live email, Slack and a
public tunnel, and sweeps that touch every workspace). To keep AI volume under control and leave that stack alone,
Muster Demo was built in **its own database, `nexaworks_demo`, on the same Postgres**, and walked with a dev web server
(`next dev` on `muster-demo.localhost:3410`) with **no worker**, `EMAIL_TRANSPORT=log` and
`INTEGRATIONS_TRANSPORT=fixture`. The script is target-agnostic: pointing it at another database builds the same
workspace there.

## Story map

Bands and numbers are what the product computed on 2026-11-21.

| # | Account | Owner | Demonstrates | Computed result |
|---|---|---|---|---|
| 1 | Halvorsen Freight | Jonah | Champion Priyanka Nair left (contact status Left, title "Former employee", email bounced), usage 62 → 13 a day, power users quiet, 2 key features stopped, 2 open high tickets | **At Risk 39.1**; Champion Loss play run + its draft waiting; AI check-in waiting (sensitive: the Watcher read the export tickets as complaints) |
| 2 | Brambleway Health | Marcus | Ticket spike with a written complaint ("Frankly this is unacceptable…") and "Please escalate…", two escalations | **At Risk 40.9**; Outreach draft **Sensitive: complaint, escalation** |
| 3 | Corvid Analytics | Jonah | Seats in use falling over 90 days, renewal in 28 days, Pulse Worried | **Watch 68.7**; renewal brief + renewal draft |
| 4 | Lindqvist Robotics | Marcus | Research team (10 people on `research.` subdomain) started 3 weeks ago, 108 of 100 seats; upgraded 80 → 100 seats 60 days ago | **Healthy 98.9**; opportunity with **$9,600 ARR estimate**; Revenue **Expansion $24,000**; expansion draft **not produced** (see FAIL 32) |
| 5 | Tamsin Bio | Jonah | Onboarding day 32: kickoff and admin guide done, first dashboard done from usage, data connection and training open, SSO (customer) 11 days overdue | Healthy 87.8, plan **Stalled**; Onboarding Manager check-in + Adoption Coach nudge waiting |
| 6 | Quarry Lane Media | Marcus | Renewal date passed 12 days ago; no email, meeting or product use for ~6 weeks | Watch 55.7; renewal open on the account (see FAIL 29) |
| 7 | Orchid & Vale Partners | Jonah | Past check-in with notes, QBR in 6 days, success plan shared to the portal, positive email, promoter NPS | Healthy 99.0; QBR draft and brief **not produced** (FAIL 34, 35) |
| 8 | Saltire Payments | Marcus | Growth annual subscription + monthly add-on (12 × $450), invoices paid / open / **failed twice** | Healthy 94.3; `payment_failed` signal |
| 9 | Fenwick Learning | Jonah | NPS 3 (detractor) + CSAT 2; follow-up email complaining; promoters elsewhere | Healthy 93.3 with Sentiment 35/100; renewal draft **Sensitive** |
| 10 | Pellucid Studio | Marcus | Churned 40 days ago | Lost, **not scored**; Revenue churn −$28,000 |
| 11 | Ashby Mercer Logistics | Marcus | HubSpot says Logistics / 201-1000, Salesforce says Freight forwarding / 51-200 | 2 open **Sources disagree** issues |
| 12 | (no account) | — | Zendesk ticket from `ops@northbeam-capital.test` | In **Inbox › Unmatched** |
| — | 25 long-tail accounts | 7 Jonah, 9 Marcus, 9 none | Steady, dipping (usage to 15%, heavy users gone) or collapsed (usage to 0, last card charge failed, the one user left) | 15 Healthy, 8 Watch, 2 At Risk; Champion Loss runs on 3; renewal, adoption and expansion drafts |

Portfolio: **4 At Risk ($201,240 ARR), 10 Watch ($125,560), 21 Healthy ($461,880), 1 not scored.** 112 open
signals. 16 approvals were waiting after the build (3 sensitive); 2 were decided during the walk.

## Feature checklist

**Result: 37 PASS · 16 FAIL · 1 not verifiable here** (54 checks). Product bugs were recorded, not fixed.

### Workspace and seed

| # | Check | Result | What I saw |
|---|---|---|---|
| 1 | Create-only script | PASS | Second run: `Workspace "muster-demo" already exists; refusing (create-only).` Workspace count stayed 1. |
| 2 | Three logins on the demo seed pattern | PASS | Settings › Users lists Rhea (Admin, revenue), Marcus (CS Leader, revenue), Jonah (CSM, own accounts, no revenue). |
| 3 | Bands computed by the product from inputs | PASS | Story accounts landed as in the story map after tuning inputs only (usage shapes, replies, tickets, Pulses); the model and scores were never touched. |

### Today

| # | Check | Result | What I saw |
|---|---|---|---|
| 4 | Today for each role | PASS | Marcus: 6 approvals, 4 at risk, $201,240 ARR at risk, overdue "Reach Jules Martin about the lapsed renewal", ranked signals ("No reply to a request for 9 days · Lindqvist", "Payment failed: invoice MDM-4275 · Saltire"). Jonah: 2 at risk (Halvorsen, Glenrock), ARR "Locked — Revenue access required", only his accounts. |
| 5 | Empty Meetings section wording | **FAIL** | With Google Calendar connected and no meeting today, Today says "No calendar connected. Meetings appear here once one is." The copy is hard-wired for every empty list (`src/app/(app)/today/page.tsx:274`). |

### Accounts list and filters

| # | Check | Result | What I saw |
|---|---|---|---|
| 6 | List, filters, sort | PASS | 36 accounts. Health=At Risk → Brambleway, Glenrock, Halvorsen, Marlowe. Tier=High-touch → Halvorsen, Lindqvist, Orchid & Vale. Stage=Onboarding → Tamsin. Owner=Jonah → exactly his 12. Search "lind" → Lindqvist. Sort by renewal → Quarry Lane (Nov 9) first; renewal dates are inline-editable date inputs with the right values. |

### Account 360 (Halvorsen Freight unless named)

| # | Check | Result | What I saw |
|---|---|---|---|
| 7 | Overview | PASS | Tier "High-touch (set by ARR rule)", ARR $148,000, Enterprise, Logistics, 1000+; key people: Delia Marsh (Decision maker), Priyanka Nair (Champion · Former employee · Left the company). |
| 8 | Health with reasons | PASS | 39 At Risk. "Why At Risk: Typical weekday active users fell from 61.4 to 13 (−79%)…", Pulse Worried, every part's reasons with linked records (usage, people, features, tickets). Health Analyst: "Champion Priyanka Nair left Nov 13, 2026 and all 7 power users have been inactive since Oct 19, 2026…", citing its reasons and signals. |
| 9 | Engagement › last meeting | **FAIL** | Says "No meeting data connected yet." although Halvorsen has a meeting on Sep 7 and one on Nov 24, and a calendar is connected. The component is hard-wired to "missing" (`src/modules/health/engine/components/engagement.ts:62`), so meetings never count. |
| 10 | People and stakeholder map | PASS | Roles per person (Champion, Decision maker, Exec sponsor, Daily users), Priyanka "Status: Left the company". Champion Guard: "Priyanka Nair needs a back-up", next-best people with reasons and "Draft an introduction". |
| 11 | People › last contact | **FAIL** | Every contact reads "Last contact: none recorded", while Champion Guard on the same page says Delia "Wrote to us 1 time… most recently on Nov 17, 2026". `Contact.lastContactAt` is never derived from mail or tickets in product code; only the Larkspur seed writes it. |
| 12 | Tickets | PASS | 2 open · 1 closed; "Exports failing since the depot change · Open · High · escalated · open 9 days". |
| 13 | Billing (Halvorsen, Saltire) | PASS | Contract (80 seats, renewal Feb 4, 2027, 60-day notice, terms), subscription with Source "Stripe", invoices. Saltire: Growth $48,000/yr ×56 and "Data connectors add-on $450/month ×12 Past due"; MDM-4275 "Payment failed (2 failed attempts)", MDM-4276 Open, older ones Paid. |
| 14 | Timeline | PASS | Play task, tickets opened/closed/escalated, Jonah's note, emails, "Email from mailer-daemon@halvorsen-freight.test: Undeliverable: Quarterly review prep", weekly usage-drop event. |

### Health, Signals, Inbox

| # | Check | Result | What I saw |
|---|---|---|---|
| 15 | Portfolio Health | PASS | At Risk 4 / Watch 10 / Healthy 21 / no data 0 with ARR per band; 30-day trend from real weekly points ("Moved to a worse band: 13, better: 1"; "Brambleway Health 70 → 41, Watch → At Risk"); "Score and CSM disagree: Corvid". |
| 16 | Lost account on the Health page | PASS | "Not scored (1): Pellucid Studio — Lost (Oct 12, 2026) · Lost account. Health is only calculated for active customers, so it is not scored." |
| 17 | Lost account's own Health tab | **FAIL** | Pellucid › Health says "Health has not been calculated for this account yet. It is calculated every night and whenever someone presses Recompute." It never will be; it should say Lost / not scored. |
| 18 | Signals | PASS | 112 open. Each shows what it means, how it is detected, false-alarm causes, proof links, Acknowledge / Mark false alarm, Draft check-in. |
| 19 | Inbox | PASS | Matched emails and tickets with "Matched by the sender's email"; Watcher reading with quotes, e.g. Fenwick "Intent: complaint · Sensitive (complaint) · Always goes to a human · Sentiment: negative 'the attendance reports take too long to build'". |
| 20 | Unmatched item | PASS | Inbox › Unmatched: "Pricing for a team of 40 analysts from ops@northbeam-capital.test… Why it is here: Ticket requester ops@northbeam-capital.test could not be matched to an account", with "Place on account". (An unmatched *email* is discarded by the privacy rule in mail ingest, so story 12 uses a ticket.) |
| 54 | Sentiment & themes | PASS | 9 negative · 2 neutral · 7 positive from 9 tickets and 9 emails; themes with verbatim quotes and source links. |

### Approvals

| # | Check | Result | What I saw |
|---|---|---|---|
| 21 | Plain approvals waiting | PASS | Renewal drafts (Corvid, Elmstead, Harbourline), Onboarding check-in (Tamsin), Adoption nudges, Champion Loss play drafts; each with "Why, with proof" and the full email. |
| 22 | Sensitive approvals | PASS | Brambleway: "Sensitive: complaint, escalation. A person always decides this; it can never be sent automatically." Halvorsen check-in: complaint. Fenwick renewal: cancellation, complaint. |
| 23 | Decided history | PASS | Rejected Redwater's play draft with a reason → "Rejected by Rhea Kapoor… 'Generic template; I will call the owner myself first.'", email cancelled. Approved Harbourline's renewal draft → "Email status: sent (log transport)" with the send checks listed. The Decided tab shows both. |
| 24 | Assignee on play drafts | **FAIL** | The four Champion Loss drafts show "Unassigned" even where the account has an owner (Halvorsen → Jonah), so they sit in nobody's queue; agent drafts on the same accounts are assigned to the owner. |
| 25 | "Open in app to review" in Slack | Not verifiable here | This is Slack DM behaviour (`src/modules/integrations/slack/service.ts:210`). Slack can't be connected without a live connector, which this task excludes. The in-app equivalent (row 22) passes. |

Note (not counted): a human-approved send lists "Not passed: quiet hours… weekends" and "Not passed: Auto-send is
switched off" beside "sent". Those are auto-send guards that don't gate a human send, but "Not passed" next to "sent"
reads like a failure.

### Plays, Onboarding, Renewals, Revenue, Expansion

| # | Check | Result | What I saw |
|---|---|---|---|
| 26 | Plays | PASS | Champion Loss PUBLISHED v1, 4 runs (Halvorsen, Glenrock, Marlowe, Redwater), all WAITING on approval, 0 skips, $163,120 protected ARR; the other plays listed as drafts. |
| 27 | Onboarding | PASS | Tamsin Bio, day 32, Stalled: "SSO setup (customer) overdue 11 days"; steps done by Jonah, "First dashboard built — Done Oct 23: product usage showed it" with proof, Connect data / Training / Review open; handoff facts sourced from the contract and roles. |
| 28 | Renewals (upcoming) | PASS | 5 renewals in 90 days, lowest confidence first, every factor with its sources; renewal briefs on Halvorsen and others. |
| 29 | Overdue renewal | **FAIL** | Quarry Lane's renewal (Nov 9) is open on the account tab, but missing from the Renewals page at every window (30 to 365 days) and from the forecast. The tab says "in -12 days" rather than overdue, and its confidence is frozen from an earlier pass ("Health is Watch (score 58.4)" while the account shows 56): open renewals past their date leave the nightly radar (`src/modules/renewals/sync.service.ts:125`). |
| 30 | Revenue | PASS | Waterfall Aug 23 – Nov 21: New $36,000 (Tamsin), **Expansion $24,000** (Lindqvist upgrade), Churn −$28,000 (Pellucid), opening + movements = closing; money at risk $148,000 (Halvorsen); billing schedule; coverage; team load. |
| 31 | Expansion opportunity | PASS | Lindqvist: "108 people used the product in the last 28 days on 100 seats: 8 seats over the limit… Estimate: $9,600.00 ARR (8 seats × $1,200.00 per seat, from their subscription)", why: seats + "New team using the product: Research (10 people)". |
| 32 | Expansion approval for Lindqvist | **FAIL** | 4 of 4 Expansion Finder answers were refused as UNCITED, so there is no Lindqvist draft. Last one, from the in-app "Ask the Expansion Finder" as Marcus: UI "The Expansion Finder's answer was not usable (uncited), so nothing was written."; run detail: `quote "seatsUsed: 108" is not in UsageDaily…; quote "seatsPurchased: 100" is not in Contract…; the number "8" is not in any record it cites`. The guard works; the agent can't pass it when the account is over its limit. (A long-tail expansion draft exists: Penrith Cycles "5 of 5 seats in use".) |

### Meetings, QBR, Surveys, Portal

| # | Check | Result | What I saw |
|---|---|---|---|
| 33 | Meetings | PASS | 2 upcoming (Halvorsen sync Nov 24, Orchid & Vale QBR Nov 27), 6 past, each linked to its account. |
| 34 | Pre-call brief | **FAIL** | The brief for the Orchid & Vale QBR failed: agent run `meeting-qbr` FAILED, `JSON schema must have a type defined if anyOf/oneOf/allOf are not used`. No brief exists. |
| 35 | QBR draft | **FAIL** | Same error for `generateQbr` (seed run). In the UI (Generate QBR, Orchid & Vale, "Q4 2026"): "The QBR could not be generated. Nothing was created. Try again." and the server log shows `Failed to generate QBR narrative: run`; the retry reuses the failed run, so retrying the same period cannot succeed. Likely cause: `metrics: z.record(z.string(), z.unknown())` / `narrative: z.array(z.unknown())` in `src/modules/agents/definitions/meeting-qbr.ts:36-37` become untyped JSON schema the live provider rejects. "Business reviews (QBRs) (0)". |
| 36 | Surveys | PASS | NPS and CSAT active; responses: Fenwick 2 (CSAT) and 3 (NPS detractor) with comments, Lindqvist 10, Orchid & Vale 9, Saltire 8; Fenwick Health › Sentiment "2 survey response(s)… averaging 35/100, impact −6.5 pts". |
| 37 | Issue a portal link from the app | **FAIL** | No page or action calls `createPortalAccess`; a CSM can't give a customer access. For the walk, one link was issued with that same service function from a scratch script (not committed). |
| 38 | Portal viewed as the customer | PASS | `/portal/<token>`: "Orchid & Vale Partners Portal — Welcome back, Imogen Vale", "Shared Success Plans: FY27 finance transformation · ACTIVE", "Business Reviews & Reports: No reports shared yet." Only that account's shared plan is shown. |
| 39 | Portal shows the plan's goals | **FAIL** | The three goals (one Achieved) don't appear; the portal page never renders goals although the service has `updatePortalGoalProgress`. |
| 40 | Success plan progress | **FAIL** | Orchid & Vale › Plans: "Progress: 0%" with 1 of 3 goals ACHIEVED. |

### Leader reports and digest

| # | Check | Result | What I saw |
|---|---|---|---|
| 41 | Leader report | PASS | Portfolio health trend generated as Marcus: At Risk 4, Watch 10, Healthy 21, ARR in At Risk $201,240, each figure linked to its records; weekly points from Oct 24. |
| 42 | Digest content | PASS | "Portfolio health declined this week: 3 accounts moved to a worse band and none moved to a better band, leaving 4 accounts At Risk and 10 on Watch now"; "5 renewals are due in the next 90 days"; 6 open tickets, 3 escalated, 5 high/urgent; every line linked. Delivered by email to the 2 leaders (log transport). |
| 43 | Digest: ticket responses | **FAIL** | "all 3 tickets opened during the period remain unanswered — no ticket opened in this period has had a first response." Every seeded ticket has a support reply 3 hours after opening, ingested on the same ticket; Zendesk ingest never sets `Ticket.firstResponseAt`, so Support risk and the digest call answered tickets unanswered. |

### Ask AI (as Marcus, live model)

| # | Question | Result | Answer and citations |
|---|---|---|---|
| 44 | "Give me a summary of portfolio health: how many accounts are Healthy, Watch and At Risk, and which accounts are At Risk?" | PASS | "Healthy: 21 · Watch: 10 · At Risk: 4 · Not enough data: 0". At Risk: Halvorsen (39.09; −79% users, champion left Nov 13), Brambleway (40.91; 5 of 5 support messages negative, −74%), Glenrock (43), Marlowe (43.27). Matches the seed. 5 citations (portfolio health + each account's Health page) and "What it read" all open (HTTP 200). It also says the tool returned 10 of the 14 Watch/At Risk accounts. |
| 45 | "Why is Halvorsen Freight at risk?" | PASS | Score 39.09; Adoption (−79%, 0 of 7 power users, 43 of 80 seats, Alerts and Scheduled reports unused), Engagement (last reply 59 days ago, no meeting for 75 days), Relationship (champion left Nov 13, Jonah's Worried Pulse), Support (2 high tickets, escalation, data-quality theme), renewal Feb 4, 2027. Matches the seed. 22 citations; every link opens. |
| 46 | "What renewals are due in the next 30 days?" | **FAIL** | "I could not answer that with sources I can show you." Run UNCITED: `the number "30" is not in any record it cites`. The number check counts the 30 from the user's own question as an uncited claim. Seeded truth: Elmstead (Dec 9), Harbourline (Dec 17), Corvid (Dec 19). Extra information, not counted: "Which renewals are due within the next month, soonest first?" answered exactly those three with dates, ARR and confidence, each cited to its renewal tab (all open). |

### Settings, scoping, integrations, provenance

| # | Check | Result | What I saw |
|---|---|---|---|
| 47 | Members | PASS | Three active members with role, book and revenue-access controls; invite form; no pending invitations. |
| 48 | Role scoping (signed in as Jonah) | PASS | Accounts "Showing 1–12 of 12", exactly his book; Marcus's Brambleway and Lindqvist pages return 404; /revenue returns 404 (no revenue access); Approvals shows only his 8; Ask AI threads are his own. |
| 49 | Integrations cards | PASS | HubSpot, Salesforce, Stripe "Connected · read-only", write-back off by default, Stripe webhook address shown; unconnected providers show connect forms. The demo's connections were created by the script **without credentials**, so the cards say "No sync has run yet" and a manual sync would not reach any provider. |
| 50 | Data-quality conflict | PASS | Settings › Data quality: "Sources disagree · Ashby Mercer Logistics — Salesforce says the industry is 'Freight forwarding', but here it is 'Logistics' (set by HubSpot). Nothing was changed. HubSpot was connected first, so the rule prefers its value." and the same for employee band. |
| 51 | Per-field provenance on the record | **FAIL** | `Account.fieldSources` is populated by ingest but shown nowhere: Ashby Mercer's overview lists Industry "Logistics" and size "201-1000" with no source. Only the Data-quality text names the source. |
| 52 | Source label on billing records | PASS | Subscriptions table "Source: Stripe". |
| 53 | Source labels on other records | **FAIL** | Accounts, contacts, tickets, emails, meetings and usage show no source (HubSpot, Zendesk, Gmail, Google Calendar, Mixpanel); the only source labels in the UI are on Billing. |

## Environment notes from the walk

- **Sign-in on `localhost`:** signing in at `localhost:3410` created a session (audit `auth.signed_in`) but the
  browser stayed signed out. The browser already held a production `__Secure-authjs.session-token` for `localhost`
  from the Docker app on `:3300`; cookies are per host, not per port, and the session lookup reads the secure-named
  cookie as well, so the dev app saw an unknown session. Serving the demo on `muster-demo.localhost` fixed it. Not
  counted as a product FAIL; worth knowing when two instances share `localhost`.
- **Playwright** has no browsers installed on this machine (installing them is a download that was not approved), so
  the walk used the desktop app's built-in browser instead.
- **No worker ran during the walk**, so approval decisions did not resume play steps, and nothing was scheduled.

## Gate on this branch

One full `pnpm gate`, run against the local Docker Postgres test database:

- typecheck PASS · lint PASS · build PASS (`next build` first stopped with Next.js' own "known security vulnerability"
  upgrade reminder, `SecurityFatalError`, then passed on a plain retry; the upgrade it recommends was not run).
- **test FAIL: 9 of 3,228**, none caused by this branch:
  - `src/lib/jobs/__tests__/outbox.int.test.ts` (2) and `src/modules/plays/__tests__/resolver-cap-outbox.test.ts` (2):
    `dispatched` is 0. Re-run alone, the same 4 fail with this branch's only product change reverted.
  - `src/config/__tests__/product-name.test.ts`: the product name also appears in tracked brand files
    (`scripts/brand-trace-logo.py`, `src/app/globals.css`, `src/components/brand/mark-geometry.ts`), not in files added here.
  - `prisma/seed/__tests__/seed.int.test.ts` (4): the full Larkspur seed timed out at 60 s against Docker Postgres.

## Follow-ups this walk found (product, not fixed here)

1. `meeting-qbr` output schema rejected by the live provider: no QBR, no pre-call brief (FAIL 34, 35).
2. Ask AI number check treats numbers from the user's question as uncited claims (FAIL 46).
3. Expansion Finder cannot pass its citation check when an account is over its seat limit (FAIL 32).
4. Overdue open renewals vanish from Renewals and freeze their confidence (FAIL 29).
5. Ticket ingest never records the first response (FAIL 43); contacts' last contact never derived (FAIL 11).
6. Portal: no way to issue a link, goals not shown (FAIL 37, 39); plan progress 0% (FAIL 40).
7. Health `last_meeting` hard-wired to missing (FAIL 9); Lost account's Health tab wording (FAIL 17); Today meetings
   empty-state copy (FAIL 5); play drafts unassigned (FAIL 24); provenance not shown outside Billing and Data quality
   (FAIL 51, 53).
