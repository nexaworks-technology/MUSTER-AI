# NexaWorks AI Customer Success Manager — Complete Product Spec
**Date:** 31 Oct 2026 · **Decision by:** Sahil (founder) · **Status:** Build spec. This product is NOT built yet. Nothing in this document is a live claim until it ships and is verified.
**Direction change:** This replaces the old direction — Signal Seat as a done-for-you service / add-on that sits on top of another CS tool. That direction is closed as the product plan. This is one complete product.

---

## 1. What this product is, in one line

**An AI Customer Success Manager that does the daily job of a CSM for every account — watches, understands, warns, prepares, drafts, follows up and reports — inside one complete product a company buys instead of Vitally, Gainsight, ChurnZero, Planhat, Totango or Clynto.**

Simple version for a buyer:
> "You hire CSMs to protect and grow customers. This product does that work with them, for every account, every day — so no customer is ignored, no risk is missed, and no renewal comes as a surprise."

**It is NOT:**
- Not a dashboard you check if you remember
- Not a health-score widget
- Not an add-on that needs Vitally/Gainsight underneath it
- Not a done-for-you service run by our team by hand
- Not a generic AI chat box

**It IS:** the system of work for the CS team. The place CSMs start their day, see every account, take action, talk to customers, run onboarding and renewals, and where leaders see revenue at risk and revenue saved.

## 2. Who it is for

**First buyer (launch segment):**
- B2B SaaS / subscription software companies
- About 50 to 2,000 customer accounts, roughly $2M-$100M ARR
- CS team of 2 to 30 people — or a founder/head of CS running CS with a very small team
- They use a CRM (HubSpot or Salesforce), billing (Stripe/Chargebee), support (Zendesk/Freshdesk/Intercom/HubSpot) and product analytics (Mixpanel/Amplitude/Segment, or their own usage API)
- Pain in plain words: "We cannot give every account attention. Our health score does not match reality. Renewals surprise us. QBR prep eats days. Our current tool needs an admin and still leaves the work to us."

**Three account types inside every customer (the product treats them differently):**
1. **High-touch** — big accounts. AI prepares and drafts. A human approves every customer-facing step.
2. **Mid-touch** — day-to-day steps can run as drafts. Human approves anything important.
3. **Long-tail / self-serve** — small accounts no CSM can touch. Safe, pre-approved steps run automatically. A human sees only real risk or real expansion.

**Not our first buyer:** very large enterprise with complex hierarchies, many regions and a full CS Ops department (Gainsight's home ground), and tiny teams with under 20 accounts who only need a spreadsheet. We can win both later. Launch where speed, proof and price hurt the incumbents most.

## 3. The promise (what a buyer should be able to measure)

1. Every account watched every day. Zero accounts with no owner, no touch and no check.
2. Risk found weeks early, with proof a CSM can act on — not a red number with no reason.
3. No surprise renewals. Every renewal visible 90 days out, with confidence and a plan.
4. CSM capacity multiplied. One CSM can safely cover far more accounts because the AI does the watching, preparing and drafting.
5. Proof of our own value. The product shows, in money: risks flagged, actions taken, accounts saved, expansion found.

## 4. How it works — the daily loop

```
CONNECT → BUILD ONE TRUE ACCOUNT VIEW → WATCH EVERY DAY
→ UNDERSTAND (health + reason) → DECIDE (what matters today)
→ ACT (task, play, draft, meeting) → HUMAN APPROVES WHERE IT MATTERS
→ FOLLOW UP → LEARN FROM THE OUTCOME → REPORT THE MONEY
```

Every feature in this spec serves one step of that loop. A feature that serves no step does not get built.

### A normal day in the product
- **8:00am — CSM opens "Today":** Top accounts that need them today, tasks due, signals that fired overnight, meetings today with a brief already ready, drafts waiting for approval. Nothing else needs checking first.
- **During the day:** CSM approves/edits drafts, works tasks, opens an account and sees everything in one place, asks the AI a question and gets an answer with its source shown.
- **Leader opens "Revenue":** Money at risk this quarter, renewals coming, expansion found, which risks were acted on, which were ignored, and what the AI saved.
- **At night:** The AI re-reads new usage, tickets, calls, emails, payments and CRM changes, updates health, raises new signals, and prepares tomorrow.

---

## 5. The product map — every screen, in simple words

| Screen | Simple job |
|---|---|
| **Today** | "What needs me today?" Tasks, new signals, meetings, approvals — only for my accounts. |
| **Approvals** | Every AI draft/action waiting for a human yes/no, in one queue. One click to approve, edit or reject. |
| **Accounts** | Every customer in one list. Search, filter, segment. Health, stage, owner, ARR, renewal date, last touch — inline editable. |
| **Account 360** | One account, everything: health and why, people, usage, tickets, calls, emails, promises, documents, onboarding, billing, timeline. |
| **Health** | All accounts by health, what moved today/this week, and the reason behind every move. |
| **Onboarding** | Every new customer, where they are stuck, and what unblocks them. |
| **Renewals** | Every renewal in the next 12 months, confidence, risk, plan and talk track. |
| **Expansion** | Accounts ready to buy more, with the proof and a draft ready. |
| **Plays** | The repeat jobs (onboarding, risk, renewal, expansion) — pre-built, running, and editable. |
| **Inbox** | Customer emails/tickets in product context, with a drafted reply based on what the customer actually wrote. |
| **Meetings & QBRs** | Call summaries, action items, pre-call briefs, and QBR/business reviews already drafted. |
| **Success Plans & Docs** | Shared plans and documents the customer can see and work on with the CSM. |
| **Revenue** | ARR movement (new, expansion, contraction, churn), forecast, money at risk. |
| **Reports** | Pre-made answers for leaders: team, portfolio, product adoption, AI results. No report builder needed to get value. |
| **Ask AI** | Ask anything about any account in plain English. Answer shows what it checked. It asks before it changes anything. |
| **Customers (Portal)** | What the customer sees: their plan, goals, progress, documents, review decks. |
| **Settings** | Integrations, health model, plays, approval rules, users, roles, data controls. Set up by answering questions, not by hiring an admin. |

---

## 6. Complete feature set — by job, in simple terms

### A. One true account view (the foundation)
1. **Account Graph** — one live record per account joining CRM, billing, usage, support, calls, email and documents. No warehouse project, no engineering ticket to start.
2. **People & stakeholder map** — every contact, their role, who is the champion / decision maker / daily user, last contact, and health of the relationship.
3. **Contract & commercial record** — value, seats/credits bought vs used, start/end dates, renewal terms, notice period, documents attached.
4. **Full timeline** — every meeting, email, ticket, usage change, payment, note and AI action in time order, on the account.
5. **Missing-data helper** — if a renewal date, owner or key contact is missing, the product asks the right person inline, in one answer, skippable, never nagging daily. Missing data never counts against an account's health.
6. **Data quality checker** — shows bad/duplicate/stale data, suggests a fix, and only changes data after a human confirms (including safe bulk fixes).

### B. Integrations (connect what they already use)
**Launch set (must work on day one):** HubSpot, Salesforce, Stripe, CSV import, Google/Microsoft calendar + email, Slack, Zendesk, Freshdesk, Mixpanel, Amplitude, Segment / Usage API, Fireflies/Gong/Zoom call recordings or transcripts, Chargebee.
**Phase 2 set:** Intercom, Pendo, Snowflake/BigQuery, Teams, Notion/Google Drive documents, Jira/Linear (for promised fixes), Clearbit-style enrichment, LinkedIn/company news for champion changes.
**Rules:** Read-only by default for CRM/billing/usage/support. Write-back only where the customer turns it on (e.g. push account fields/tasks to Salesforce/HubSpot). Every sync shows last-run time and errors in plain words.

### C. Health & risk engine (the heart)
1. **Health in 6 parts, not one black-box number:** Adoption, Engagement, Support, Relationship, Commercial, Sentiment. Each part scored and shown separately.
2. **"Why" behind every score** — tap any score: the exact signals, values, dates and sources that moved it. A CSM must be able to defend it in a board meeting.
3. **Scored against the account's own normal + its group** — a small account that uses the product twice a week may be healthy; an enterprise doing the same may be dying. Also compared with accounts like it (same size, plan, use case), because "adopted" means different things for different kinds of customers.
4. **AI proposes the first health model** — from the customer's own past renewed vs churned accounts, the product proposes weights and shows a back-test: "With this model, we would have flagged 8 of your last 10 churns, on average 41 days early, with X false alarms." The human approves or edits it. Nobody starts from a blank settings page.
5. **CSM Pulse** — a CSM can tap "actually fine" or "worried" on any account. Pulse is a real input to health, and disagreements between the score and the CSM are shown, not hidden. This is the lesson from real teams shelving Vitally scores that fought CSM judgment.
6. **Health history & back-testing** — change the model, see what it *would have said* in the past before you trust it live.
7. **Risk levels:** Healthy / Watch / At Risk, with a named reason for every At Risk account (never risk with no reason).

### D. Signals (what the AI watches for)
Signals are grouped so a buyer understands them in minutes. Each signal has: what it means, how we detect it, how early it usually appears, and what can make it a false alarm.
- **Usage:** drop vs own normal, key feature stopped, power user gone quiet, seats/credits running out early (expansion) or unused (risk), adoption stall in onboarding
- **People:** champion silent / bounced / role change / left company, new decision maker joins, no meeting in X days, email engagement stops
- **Support:** ticket open too long, repeat problem, angry sentiment, escalation, "how do I export/cancel" language
- **Calls & email:** competitor mentioned, budget concern, promise made, complaint repeated, goal stated, renewal concern, no reply to important follow-ups
- **Money:** payment failed/late, contract ending, usage hitting paid limit, new team/department starting to use the product
- **Promises:** a fix/feature/date promised to the customer that is late or has no owner (Promise Tracker — see H4)
- **Outside:** customer company funding, hiring, leadership change, acquisition — only from public sources, always dated, never framed as fresh if it is old

### E. The AI team (agents — each has ONE job)
An "agent" here means a specialist worker inside the product, not a marketing label. Each agent shows: what it read, what it decided, what it did/drafted, and its past accuracy.
1. **Watcher** — reads all new data nightly + in real time for big signals, raises signals, updates the Account Graph.
2. **Health Analyst** — updates the 6-part health model, writes the top 1-2 risks/opportunities per account in plain language.
3. **Champion Guard** — watches champion contacts for silence, bounce, role/departure signals; suggests the next best person to build a relationship with.
4. **Onboarding Manager** — tracks every new account against its plan, flags stalls, drafts check-ins, escalates a stalled account before it becomes a churn.
5. **Adoption Coach** — compares usage with what the account bought and with accounts like it; finds unused value and drafts the exact nudge/training step.
6. **Support Risk Agent** — reads tickets for age, repeats and sentiment; flags accounts where support pain is becoming renewal risk; drafts replies in Inbox.
7. **Promise Keeper** — extracts promises from calls, emails and tickets, gives each an owner + date, and chases late promises internally before the customer does.
8. **Renewal Manager** — builds the renewal plan 90 days out: confidence, risks, expansion chance, talk track, draft outreach, and the next step with a date.
9. **Expansion Finder** — finds limit-hits, new users/teams, fast growth and stated goals that mean more revenue; drafts the expansion conversation, never a hard pitch with no proof.
10. **Meeting & QBR Agent** — pre-call brief in minutes, call summary + action items after, and a full business review (QBR) drafted from real numbers — narrative written from the numbers, charts only where real data exists.
11. **Outreach Agent** — drafts emails/tasks for every approved action, in the company's voice (learned from their real sent examples, never a template sent word-for-word). By default it drafts. It sends alone only where an admin has turned auto-send on for that play, with the guards in section J.
12. **Digital CSM (long-tail)** — runs safe, pre-approved plays end-to-end for small accounts that have no human CSM, and hands over to a human the moment risk, anger, pricing, legal or a real opportunity appears.
13. **Leader Reporter** — weekly: money at risk, renewals, expansion, team actions, AI saves and outcomes. No dashboard digging needed.
14. **Ask AI (Copilot)** — answers plain-English questions across all accounts ("Which accounts mentioned a competitor this month, and what did they say?"), always naming the sources it checked. It confirms before changing any record.
**Custom agents (Phase 2):** a team can describe a job in plain words and the product builds a testable agent, tested against past accounts before it runs live.

### F. Daily work for the CSM
1. **Today queue** (section 5) — ranked by money + urgency, not by who shouted loudest.
2. **Approvals queue** — all drafts/actions waiting, with the reason and proof attached, approve/edit/reject in seconds.
3. **Tasks** — created by plays, agents or humans; owner, due date, account context attached; overdue tasks escalate to the leader view.
4. **Notes** — fast notes on any account/meeting, templates per call type, tags and mentions; notes can trigger a play.
5. **Segments** — group accounts by stage, plan, health, industry, owner or any trait, in a few clicks, no code.

### G. Onboarding & adoption
1. **Onboarding plans** — a clear plan per new account: steps, owner (us / customer), dates, and what "done/value reached" means for *that* kind of customer.
2. **Time-to-value tracking** — is this account reaching first real value on time vs accounts like it? Stalls flagged with the likely blocker.
3. **Handoff from Sales** — a new-customer handoff play: everything Sales promised, goals stated on calls, key people, and risks — assembled automatically, so CS does not start blind.
4. **Adoption view** — seats/credits used, features used vs bought, power users, decline curves — at account level, in CS language, not raw product events.

### H. Renewals, expansion & revenue
1. **Renewal Radar & forecast** — every renewal for 12 months, confidence per account with reasons, and a team forecast a leader can trust because each number opens into proof.
2. **Renewal Brief** — one page per big renewal: health + why, goals achieved, open risks, promises status, expansion chance, suggested talk track.
3. **Expansion pipeline** — expansion signals become tracked opportunities with value estimates labelled as estimates, owner and next step. Export/sync to CRM.
4. **Promise Tracker** — see D/H: every open customer promise across the portfolio, late ones first. (Also listed as an agent because it needs a worker, and as a screen because leaders must see it.)
5. **Revenue view** — ARR waterfall: new, expansion, contraction, churn. Invoice-level billing forecast from each account's billing cycle (from Stripe/Chargebee/CSV).
6. **Save record** — every churn save and expansion win linked back to the signal and action that caused it.

### I. Plays (playbooks that actually run)
1. **15 plays ready on day one (drafts, inspect before turning on):** Health Risk, Renewal Risk, Renewal Window (90/60/30), Onboarding Stall, New Customer Handoff, Champion Loss, Adoption Drop, Expansion Opportunity, Payment Failed, Support Escalation / SLA Breach, Promise Late, QBR Due, Engagement Loss / Re-engagement, Cancellation Save, Business Review Follow-up.
2. **Simple builder** — trigger → condition → steps (notify / task / draft / send / update / escalate). Branch by account type, health, ARR or renewal date. Or describe the play in plain words and the product builds it for review.
3. **Safety check before publishing** — the builder refuses to publish a play that would do nothing, has a missing setting, a step with no handler, or a trigger with no agent able to detect it. (Buyers have been burned by pretty diagrams that never fired.)
4. **Play results** — for each play: how many accounts entered, actions taken, replies, saves, revenue. Dead plays are visible and can be killed.

### J. Communication
1. **Inbox** — customer email becomes a ticket/item on the right account; AI reads the real subject/body, judges intent + sentiment, drafts a reply to what was actually said. Draft by default.
2. **Campaigns to a segment** — build the audience with a filter, write in a simple editor, send now or schedule, track delivered/open/click/bounce, unsubscribes always honoured, sending paced. For CS motions (check-ins, feature/value nudges), not a marketing tool replacement.
3. **Slack** — signals, approvals and digests where the team already works; approve a draft from Slack.
4. **Auto-send guards (always on when auto-send is enabled for any play):** no send if that contact was emailed in the last 3 days; no send if another play emailed the account in the last 48 hours (goes to Approvals instead); quiet hours in the customer's time zone; held while a serious support ticket is open; never for Lost accounts; never auto-reply on cancellation, pricing, legal, security, complaints or escalations — those always go to a human.
5. **Customer Portal & Docs** — a shared, live place per account: success plan, goals, progress, documents, business reviews. Replaces slide-deck/email chains for the plan itself. (Docs editing is Phase 2 depth; a clean shared plan + review view is launch scope.)

### K. Meetings, QBRs & voice of the customer
1. **Pre-call brief** — 2 minutes before any call: health + proof, last conversations, open tickets/promises, renewal, suggested questions.
2. **Call summaries** — from connected recordings/transcripts: summary, decisions, action items with owners, risks/goals/promises extracted into the account automatically.
3. **Auto business review (QBR)** — pick account + period; product drafts the review: summary, health by part with commentary, adoption, support experience, goals vs results, risks, recommendations, action plan. Numbers are computed from real data; a human edits the story, never the numbers.
4. **Surveys** — NPS / CSAT / CES at the right moment in the journey, results feed health (Sentiment + Relationship) and can trigger a play. Kept simple; not a survey platform.
5. **Sentiment & themes** — across calls, emails, tickets and surveys: what customers are happy/angry/confused about, per account and across the portfolio, with quotes as proof.

### L. Leaders, reporting & proof of value
1. **Revenue & risk home** — money at risk (next 30/90 days), forecast, coverage (accounts with no touch), team load.
2. **Pre-made reports** — portfolio health trend, adoption, onboarding time-to-value, renewal outcomes, expansion found, support risk, team activity vs outcomes. Filters, no builder needed.
3. **"Did It Work?" — the outcome ledger (our proof engine)** — for every AI flag: signal → action taken (or ignored) → outcome at 7/30/90 days (replied, meeting, recovered, renewed, expanded, churned). This produces the sentence a leader actually renews on: "In 90 days it flagged 61 risks, the team acted on 54, 47 recovered or renewed — worth $X."
4. **AI accuracy view** — per agent/signal: true alarms vs false alarms, CSM acceptance rate. Signals that cry wolf get tuned or killed, visibly.

### M. Ask AI, search & commands
1. Ask across accounts, people, calls, tickets, contracts and documents in plain English; answers cite sources; no answer is invented when the data is not there ("I cannot see a contract for this account").
2. Voice + file upload: hand it a contract or a call transcript and ask about it.
3. Confirmed actions: "Move these 40 accounts to the renewal play" shows exactly what will happen and waits for a yes, even for bulk actions.

### N. Trust, control & security (non-negotiable for this category)
1. **Approval levels per step, per account type:** Notify only / Draft for approval / Draft in mailbox / Do automatically / Send automatically. High-touch defaults to approval. Long-tail can default to automatic for safe steps only.
2. **Full audit trail** — every AI decision shows inputs, reasoning summary, action, who approved, and outcome. Exportable.
3. **Tenant isolation** — each customer's data separated at the database level. Field-level extra protection for pricing/contract terms.
4. **Never trains shared models on a customer's data.** Their data serves only their company.
5. **Roles & permissions** — Admin, CS Leader, CSM (sees own book by default), Viewer, plus a separate permission for revenue/financial views.
6. **Security path, stated honestly in the sales process:** encryption in transit/at rest, backups, DPA available, SOC 2-aligned controls from launch, SOC 2 Type II as a dated roadmap item before enterprise sales — never claim a certificate we do not hold.
7. **Delete/export** — a customer can export all their data and request full deletion, with a stated timeline.

### O. Setup — live in days, no admin army
1. Connect launch integrations → import accounts → AI proposes health model + segments + plays from their data/history → human reviews in one working session → back-test shown → go live.
2. Target: first real Risk/Today queue on day 1 from CSV/HubSpot/Stripe; full launch integrations inside 2 weeks. (Targets to prove in pilots, not marketing claims until pilots prove them.)
3. No implementation fee, no required consultant, no 3-month project. Help is product + human onboarding support, not a services engagement.

---

## 7. How we compete — parity first, then our edges

**Parity rule:** a buyer comparing us with Vitally / Gainsight / ChurnZero / Planhat / Clynto must find every core job present: account 360, health, plays/journeys, tasks, onboarding, renewals + forecast, expansion, segments, dashboards/reports, surveys, success plans, customer sharing, in-product communication basics, AI summaries + AI assistant, integrations, permissions/audit. If a core job is missing at launch, it must be on a dated phase (section 8), never hidden.

| Core job | Vitally | Gainsight | ChurnZero | Planhat | Clynto | **Us — launch plan** |
|---|---|---|---|---|---|---|
| Account 360 / workspace | Yes, polished Hubs + Docs | Yes, enterprise depth | Yes, Command Center | Yes, flexible data model | Yes, 8-tab account view | **Yes — launch** |
| Health score | Custom, you configure/maintain | Scorecards, admin-maintained | ChurnScore, you pick factors | Flexible models by segment | 6 pillars, why shown | **Yes — launch, with proof + back-test + CSM Pulse** |
| Plays / journeys | Playbooks, you build | Journey Orchestrator (add-on in some tiers) | Plays + Journeys, branching | Workflow engine | Builder + 15 seeded | **Yes — launch, 15 seeded + safety check** |
| AI agents | Copilot/Quin assistant, meeting AI | Agents + Staircase conversation AI (separate sub in some tiers) | 14 AI teammates marketplace, Engagement AI | Pi multiplayer agent + agents | 20 agents, custom no-code | **Yes — 13 named agents at launch, custom in Phase 2** |
| Conversation intelligence | Conversation sync + AI summaries | Via Staircase acquisition | Engagement AI (email/calls/surveys sentiment) | Conversational AI feeds health | Email responder + sentiment | **Yes — launch: calls/tickets/email sentiment, promises, competitor mentions in core, not an add-on** |
| Onboarding | Playbooks/projects | Journeys + plans | Journeys + in-app WalkThroughs | Workflows | Onboarding tabs/workflows | **Yes — launch: plans, stalls, time-to-value, sales handoff** |
| Renewals + forecast | In platform | Renewal Center + forecasting | Renewal & Forecast Hub | Revenue workflows | Renewal briefs + ARR view | **Yes — launch: Radar, Brief, forecast, ARR waterfall** |
| Customer-facing sharing | Docs — a real strength | Success plans, communities (separate) | Success Centers + in-app | Customer portal | Reports/documents Studio | **Launch: shared Success Plan + Reviews. Phase 2: full Docs depth + portal** |
| In-app engagement (inside *their* product) | Limited focus | PX is a separate product | Strong: messages, WalkThroughs, Success Centers | Portal focus | Campaigns/email focus | **Phase 2 (SDK) — say so openly; launch covers email/Slack/portal** |
| Surveys / NPS | Yes | Yes | Yes, native | Yes | Basic via signals | **Yes — launch, simple NPS/CSAT/CES** |
| Setup speed | Weeks, owner needed | Months + admin commonly reported | Weeks (~3 months reported by users) | ~3 months reported | Same day basic | **Target: day-1 queue, full in 2 weeks, AI proposes the setup (prove in pilots)** |
| Pricing | Quote-only, third-party median ~$35k/yr | Quote-only, median ~$50k/yr + implementation + admin | Quote-only, est. $30-50k/yr range in comparisons | Quote-only, est. $25-60k/yr range | $199/mo flat, early-stage focus | **Published simple pricing, no implementation fee — final price is a founder decision (section 10)** |

*Competitor facts above are from their public sites / reputable comparisons checked 31 Oct 2026; medians and ranges are third-party estimates, not vendor-published prices, except Clynto's $199 which is published on its site.*

### Our 6 edges (design goals — we claim them only as each is proven in pilots)
1. **Proof-first health.** Every score opens into signals, dates and sources, back-tested on the customer's own churn history before go-live. Plus CSM Pulse, so the system never silently fights the human who knows the account.
2. **Adoption defined per kind of customer.** "Good usage" is defined by cohort/use case, not one global rule — the exact failure that made real teams kill generic scores.
3. **Conversations + promises in the core.** Calls, tickets and email are read for risk, goals, competitor mentions and *promises made and forgotten* — in the base product, not a paid AI add-on.
4. **Setup the AI does, the human approves.** Health model, segments and plays are proposed and back-tested, not built from a blank page by an admin over months.
5. **Outcome ledger.** Signal → action → result, in money, per account and per play. The product must prove it saves accounts, or the buyer should churn us.
6. **Complete platform, simple buying.** Published price, no implementation project, month-to-month option, live in days — against quote-only, admin-heavy incumbents.

### Where incumbents still beat us at launch (say it, do not bluff)
Enterprise scale/hierarchies and deep forecasting (Gainsight), polished customer Docs (Vitally), native in-app walkthroughs (ChurnZero), flexible enterprise data modelling + European depth (Planhat), cheapest flat deal for a pre-hire 1-person team (Clynto). Our launch win zone is mid-market B2B SaaS that wants a complete AI CSM without the platform tax.

## 8. Build phases (estimates — to be re-estimated with Pavan before committing dates)

**Phase 0 — Clickable prototype + design-partner demo (target ~2 weeks)**
Sample-data full product: Today, Account 360, Health+Why, Renewals, Approvals, Ask AI (canned on sample data). Purpose: sell design partners, not the public. Nothing here is marketed as working product.

**Phase 1 — Launch product / V1 (target ~8-10 weeks of focused build)**
Everything marked "launch" above: Account Graph + launch integrations (HubSpot, Salesforce, Stripe, CSV, email/calendar, Slack, Zendesk/Freshdesk, Mixpanel/Amplitude, call transcripts), 6-part explainable health + back-test + Pulse, signals, 10 of the 13 agents (Watcher, Health, Champion, Onboarding, Adoption, Support Risk, Promise, Renewal, Expansion, Meeting/QBR) + Ask AI, Today + Approvals, onboarding plans, Renewal Radar/forecast + Revenue view, 15 seeded plays + simple builder, Inbox drafts, campaigns (basic), surveys (simple), Success Plan sharing, leader reports + outcome ledger, roles/audit/approval levels + auto-send guards, AI-proposed setup.
Outreach + Digital CSM agents can run in limited form on the seeded plays at V1; full autonomy tuning is Phase 2 learning.

**Phase 2 — Depth (next ~6-8 weeks after V1 pilots)**
Custom agents, full Docs editing + richer customer portal, in-app engagement SDK (messages/walkthroughs), advanced forecasting, custom objects, warehouse connectors (Snowflake/BigQuery), Teams, Jira/Linear promise sync, multi-product/multi-region accounts.

**Phase 3 — Enterprise readiness (only when deals demand it)**
SSO/SCIM depth, data residency options, SOC 2 Type II completion, advanced admin/governance. Do not build this before a buyer needs it.

**Team reality check:** this is a full platform build, not a landing page. It needs Pavan (product/technical) full-time on it, founder on design-partner pilots weekly, and a hard rule: no new side offers/features outside this spec while V1 is being built.

## 9. Simple data model (what the product stores, in plain words)
Company (our customer) → Accounts (their customers) → Contacts, Contracts, Subscriptions/Invoices, Usage (per account/per user), Tickets, Conversations (calls/emails/chats), Meetings, Signals, Health Snapshots, Promises, Goals/Success Plans, Tasks, Plays & Play Runs, Agent Runs (with reasoning + outcome), Approvals, Documents/Reviews, Surveys, Campaigns, Revenue Events, Audit Log. Every AI output links back to the records it read. No orphan AI text.

## 10. Open founder decisions (only these — everything else in this spec is decided as written)
1. **Product name** — "NexaWorks AI CSM" working name in this spec. Final name before prototype.
2. **Published price** — principle decided: simple, published, no implementation fee. Exact number/structure (per CSM seat vs per account band) is a founder call before Phase 0 demo.
3. **First 3 design partners** — who gets Phase 0/1 first, free/discounted in exchange for weekly feedback + outcome data.
4. **Build commitment** — confirm Pavan full-time + no parallel product tracks until V1 pilots are judged.

## 11. How we will judge V1 (kill / continue lines for the pilots)
- **Trust:** CSMs accept/agree with at least 60% of AI risk flags (rest tuned, not defended).
- **Use:** CSMs open Today/Approvals at least 4 days a week without being chased.
- **Time:** QBR/meeting prep time at a pilot drops from hours to under 30 minutes.
- **Outcomes:** in 90 days, flagged-and-acted accounts renew/expand measurably better than flagged-and-ignored ones, shown in the outcome ledger. If we cannot show this, the product is a dashboard, not an AI CSM — fix or kill.
- **Buying:** at least 2 of the first 3-5 design partners convert to paid at the published price when the pilot ends. If 0 convert, the segment or the product is wrong — not the effort.

## 12. One-page pitch (simple, use as-is for the prototype)

> Vitally and Gainsight give your CS team a platform — then your team configures it, maintains it, watches dashboards, and still does all the work.
>
> The new AI tools give you an assistant or a few agents on top of that same platform.
>
> **We built the manager itself.** NexaWorks AI Customer Success Manager watches every account across your CRM, product, support, calls, email and billing. It understands health and shows you the proof. It runs onboarding, prepares renewals 90 days early, catches your champion leaving, tracks the promises your team made, finds expansion, and drafts the next step for every account — for your big accounts with your approval, and for the small accounts nobody has time for, automatically and safely.
>
> Your CSMs start each day knowing exactly who needs them and why. Your leaders see exactly how much money is at risk, and afterwards, exactly how much was saved.
>
> One complete product. Live in days, not months. No admin army. No black-box score.
