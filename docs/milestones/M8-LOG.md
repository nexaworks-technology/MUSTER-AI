# M8 — Plays Engine: Log

**Status:** **Milestone Complete (2026-11-05)**: Slices S1–S16 committed, all Tier-2 close ritual test suites green (`pnpm test:e2e`: 75 passed, 0 failed, 55 skipped; `pnpm gate`: 200 files / 1,840 tests passed, lint 1,031 files 0 warnings, typecheck 0 errors, Next.js build clean), 5-scenario fresh scratch DB demo verified.

---

## Slices Committed

### Session 1 Slices (S1–S8)

| Slice | Commit | Description | Targeted Test Evidence |
|---|---|---|---|
| S1 Q-48 | `3bdeb08` | `Task.signalId` composite FK; `completeTask` marks `OutcomeRecord` ACTED; M6 & M7 agent tasks link to signalId. | `src/modules/tasks/__tests__/task-signal-actioned.int.test.ts` (5 passed) |
| S2 Migrations | `ee4429c` | `Play`, `PlayVersion`, `PlayRun`, `PlayStepRun` models; `ApprovalStatus.AUTO_RECORDED`; backlog migration marking pre-M8 outbox events processed (D3). RLS + tenant isolation. | `src/modules/plays/__tests__/tenant-isolation-m8.int.test.ts` (11 passed) |
| S3 Safety Gate | `4fad4ed` | `PlayDefinition` Zod schema; `validatePlaySafety` hard gate pre-publish refusing missing approval levels, sensitive auto-sends, cap breaches, template violations, segment exclusions, dormant plays; `publishPlay`. | `src/modules/plays/__tests__/safety.test.ts` (12 passed, red-first verified) |
| S4 Step Resolver & Caps | `436e259` | Step-level approval resolver reusing M4 logic; pure runtime frequency cap check; outbox fan-out to multiple workers; `approval.decided` and `note.created` event types. | `src/modules/plays/__tests__/resolver-cap-outbox.test.ts` (12 passed, red-first verified) |
| S5 Runner & Handlers | `23804fc` | `runner.ts` + 7 step handlers (`notify`, `task`, `draft`, `send`, `update`, `escalate`, `wait`, `exit`); approval wait and resume; stall sweep + escalation Task (Q-65); BullMQ queue `plays`; D10 agent sweep guards; single send choke point proof. | `src/modules/plays/__tests__/runner.int.test.ts` (10 passed) |
| S6 Auto-Send Enablement | `3fe1960` | Settings schema `autoSendEnabled: false` default; Admin-only master switch with typed confirmation (`ENABLE AUTO-SEND`) + audit log; runner integration with D7 AUTO proof path (`AUTO_RECORDED` approval row). | `src/modules/plays/__tests__/permissions.test.ts` (3 passed), `src/modules/plays/__tests__/auto-send.int.test.ts` (8 passed) |
| S7 15 Seeded Plays | `776f769` | Seeded 15 plays per D9 (11 live, 4 dormant: Promise Late [M9], QBR Due [M10], Engagement Loss [M9/M10], Business Review Follow-up [M10]); `seedPlaysForWorkspace` idempotent create-only. | `src/modules/plays/__tests__/seeded-plays.test.ts` (4 passed) |
| S8 UI & Play Operations | `7104a12` | `/plays` list and `/plays/[id]` inspector UI; actions for duplicate, publish/pause/kill, version history, and D4 retroactive entry opt-in at publish. | `src/modules/plays/__tests__/plays-service.int.test.ts` (6 passed) |
| Fix: Agent Signal Validation | `53ed8c4` | Safely validate `signalId` existence in `renewal-manager` and `onboarding-manager` before task attachment to prevent composite FK violations. | `src/modules/agents/__tests__/renewal-manager.int.test.ts` (7 passed), `src/modules/agents/__tests__/onboarding-manager.int.test.ts` (10 passed) |

### Session 2 Slices (S9–S16) & Close Ritual

| Slice | Commit | Description | Targeted Test Evidence |
|---|---|---|---|
| S9 Outreach & Digital CSM | `0655b8a` | Outreach agent extended (prompt 1.1.0; `VoiceSample` capture in Settings, same-workspace samples only, Rule 8) and `digital-csm` agent with hand-off rules (long-tail accounts; every draft to Approvals; hand-off to human recorded on run). | `src/modules/agents/__tests__/digital-csm.int.test.ts` (5 passed), `src/modules/agents/__tests__/voice-samples.int.test.ts` (7 passed) |
| S10 Play Builder | `e239035` | `play-builder` assistant in AI team (D-138): plain words → draft play version via `AgentRun`; never publishes directly and cannot bypass `validatePlaySafety` (faces identical publish gate as hand-authored plays). | `src/modules/plays/__tests__/play-builder.int.test.ts` (5 passed) |
| S11 Results, Dead-Play, noteTag | `f75cec0` | `/plays/[id]/results` page with stats/skips/runs; dead-play detection (red first: published play with no entries over window flagged, never auto-killed); kill action; `noteTag` trigger consumer for Cancellation Save. | `src/modules/plays/__tests__/results-and-cancellation.int.test.ts` (6 passed, red-first verified) |
| S12 Plan Adoption | `624ec75` | Renewal plan adoption (D-139): human "Adopt" action on `/renewals/[id]/brief` into `Renewal.planSteps`; steps editable before adoption; validated by M7 placeholder validator; audited. No silent adoption. | `src/modules/renewals/__tests__/plan-adoption.int.test.ts` (7 passed) |
| S13 Campaigns Schema & Approval | `61e364a` | `ApprovalKind.CAMPAIGN` with `accountId` nullable ONLY for campaigns (`approval_campaign_account_null` DB check); decision rights restricted to Admin/CS Leader; `dispatch` campaign mode enforcing guards 1, 3, 4, 5, 7 per recipient without weakening normal path. | `src/modules/campaigns/__tests__/campaign-approval-dispatch.int.test.ts` (8 passed) |
| S14 Campaign Editor, Pacing, Webhooks | `9f4c8e9` | Campaign UI (`/campaigns`, `/campaigns/new`, `/campaigns/[id]`), schedule, pacing pure module (red first), HMAC-signed unsubscribe route (`/api/email/unsubscribe`, `/unsubscribe`), provider webhook receiver (`/api/email/webhook`) with Svix/Resend signature verification. Live Resend verification DEFERRED. | `src/modules/campaigns/__tests__/pacing.test.ts` (6 passed, red-first verified), `src/modules/campaigns/__tests__/campaign-pacing-webhook.int.test.ts` (7 passed) |
| S15 Proposed Plays Wizard Step | `32b7d69` | Setup wizard "Proposed plays" step inserted before Go live: deterministic proposal rules (red first, no LLM); proposals land as DRAFT plays facing normal safety gate; step count updated ("Step 1 of 5" → "of 6"). | `src/modules/setup/__tests__/proposed-plays.test.ts` (7 passed, red-first verified) |
| S16 E2E, A11y, Navigation Gating | `f14daa3` | Navigation gating (`SHIPPED_MILESTONE = 8`), `features.test.ts` updated with Plays row (`/campaigns` tab under Plays), `e2e/m8-plays.spec.ts` (14 assertions), `e2e/a11y-m8.spec.ts` (axe checks desktop + 375px mobile). | `e2e/m8-plays.spec.ts`, `e2e/a11y-m8.spec.ts` (75 passed in full E2E run) |
| Fix: E2E Selectors & A11y Contrast | `cbfb5d4` | Refined E2E test selectors, resolved subtle a11y color contrast on results badges, added reusable `Textarea` component. | Targeted E2E and unit suites |
| Fix: Task Escalation Today Cache | `a1be50d` | Rebuild workspace Today cache upon escalating overdue play runs and tasks. | `tasks.int.test.ts` |
| Demo: Scratch DB Verification | `27533f9` | Fresh scratch database demo script (`scripts/demo-fresh-db.ts`) running all 5 founder milestone scenarios end-to-end. | Scratch DB script run: 5/5 passed |
| Fix: Module Boundary & Types | `712d626` | Re-exported module internals via service barrels to satisfy `eslint` module boundary rules; refined typing for `runAgent` outcomes and approval decided handlers. | `pnpm typecheck && pnpm lint` (0 errors) |
| Fix: Campaign Inbound & Approval | `9281767` | Resolved `findOutboundMessageByProviderId` across workspaces and aligned `ForbiddenError` message for campaign approvals. | `campaign-approval-dispatch.int.test.ts`, `campaign-pacing-webhook.int.test.ts` |

---

## Red-First Test Evidence

In accordance with founder execution rules, pure modules were written test-first with red evidence logged prior to implementation:

1. **S11 Dead-Play Detection (`dead-play.ts`):**
   - Red test run executed against empty implementation: `TypeError: checkDeadPlay is not a function`.
   - Implementation landed in `dead-play.ts` evaluating entry counts against `deadPlayThresholdDays` window; flagging `isDead: true` while strictly never auto-killing.
   - Green re-test: 6/6 tests passed in `results-and-cancellation.int.test.ts`.

2. **S14 Campaign Pacing Pure Module (`pacing.ts`):**
   - Red test run executed against empty `calculatePacedBatches`: `ReferenceError: calculatePacedBatches is not defined`.
   - Implementation landed in `pacing.ts` enforcing `pacePerHour` constraints, batch window distribution, and zero-pace fallbacks.
   - Green re-test: 6/6 tests passed in `pacing.test.ts`.

3. **S15 Proposed Plays Deterministic Rules (`proposed-plays.ts`):**
   - Red test run executed against unbuilt proposal module: `TypeError: proposePlaysForWorkspace is not a function`.
   - Implementation landed in `proposed-plays.ts` evaluating workspace traits (integrations present, account tiers, usage volume) deterministically without LLM hallucinations.
   - Green re-test: 7/7 tests passed in `proposed-plays.test.ts`.

---

## Acceptance Checklist Verification

| # | Check | Specification Requirement | Verification Evidence | Status |
|---|---|---|---|:---:|
| 1 | `pnpm gate` green | Full typecheck, lint (0 warnings), vitest (all suites), production Next.js build | Exit code 0; 200 files / 1,840 tests passed; 1,031 files scanned with 0 secrets/warnings; Next.js 42/42 static routes compiled | **PASS** |
| 2 | `pnpm test:e2e` green | Full Playwright suite incl. `e2e/m8-plays.spec.ts` | 75 passed, 0 failed, 55 skipped in 3.1m (`task-3544`) | **PASS** |
| 3 | Safety check refuses defined reasons | Pre-publish gate refuses in plain words | `src/modules/plays/__tests__/safety.test.ts` (12/12 passed) | **PASS** |
| 4 | 15 seeded plays (11 live, 4 dormant) | 11 publishable, 4 dormant naming missing detectors | `src/modules/plays/__tests__/seeded-plays.test.ts` (4/4 passed) + fresh DB demo Scenario 1 & 2 | **PASS** |
| 5 | Sensitive draft never auto-sends | Sensitive topics capped at `DRAFT_FOR_APPROVAL` | `src/modules/outbound/__tests__/auto-send.int.test.ts` (8/8 passed) | **PASS** |
| 6 | Every guard holds to Approvals | Outbound dispatch guards hold to pending approval | `auto-send.int.test.ts` + fresh DB demo Scenario 3 (Orchard Lane cap) | **PASS** |
| 7 | Unsubscribed contact never receives | `EmailSuppression` enforced on approved & campaign sends | `src/modules/campaigns/__tests__/campaign-approval-dispatch.int.test.ts` + fresh DB demo Scenario 4 | **PASS** |
| 8 | Play entry + steps idempotent | Same trigger twice ignored; step retry safe | `src/modules/plays/__tests__/runner.int.test.ts` (10/10 passed) | **PASS** |
| 9 | Auto-send Admin-only | Typed confirmation `ENABLE AUTO-SEND` + audit trail | `src/modules/plays/__tests__/permissions.test.ts` (3/3 passed) | **PASS** |
| 10 | Single send choke point | All customer email via `outbound.dispatch` exclusively | `src/modules/outbound/__tests__/import-graph.test.ts` (3/3 passed) | **PASS** |
| 11 | AgentRun populated & cited | outreach, digital-csm, play-builder fully audited | `digital-csm.int.test.ts`, `play-builder.int.test.ts` | **PASS** |
| 12 | Voice samples workspace-isolated | Admin voice samples never cross tenants (Rule 8) | `src/modules/agents/__tests__/voice-samples.int.test.ts` (7/7 passed) | **PASS** |
| 13 | Play results show statistics & redaction | Entered/sent/held/skips; money redacted without permission | `/plays/[id]/results`, `results-and-cancellation.int.test.ts` | **PASS** |
| 14 | Tenant isolation for 7 new models | Play, PlayVersion, PlayRun, PlayStepRun, Campaign, CampaignRecipient, VoiceSample | `src/lib/db/__tests__/tenant-isolation-m8.int.test.ts` (11/11 passed) | **PASS** |
| 15 | Query budget / no N+1 | Runner and results queries chunked within budget | `src/modules/plays/__tests__/runner.int.test.ts` query budget assertions | **PASS** |
| 16 | axe accessibility | Desktop & mobile 375px on `/plays`, `/campaigns`, results | `e2e/a11y-m8.spec.ts` (passed in Playwright suite) | **PASS** |
| 17 | Real email provider webhooks | Live Resend sandbox delivery verification | Log transport verified; live sandbox credentials absent → recorded as DEFERRED per founder instruction | **DEFERRED** |
| 18 | Task completion marks flag ACTED | `Task.signalId` link; completing task marks `OutcomeRecord` | `src/modules/tasks/__tests__/task-signal-actioned.int.test.ts` (5/5 passed) | **PASS** |

---

## Decisions Recorded (D-128 through D-142 in `docs/DECISIONS.md`)

- **D-128 (D1):** A frequency-cap breach at run time makes the step SKIPPED with the reason recorded on the run (never queued, never sent). All other guards still HELD → Approvals at dispatch. No task is created for a skip.
- **D-129 (D2):** A run is unique on `(workspaceId, playId, accountId, triggerRef)`. The play version is recorded on the run; at most one OPEN run (`RUNNING` or `WAITING`) per play+account; a second trigger while one is open is ignored and logged.
- **D-130 (D3):** Outbox routes may fan out to several jobs, but existing single routes stay byte-identical. Added `approval.decided` and `note.created` events. A data migration marks pre-M8 backlog events processed (no history flood). Runs enter only for signals first seen after publish.
- **D-131 (D4):** Retroactive entry is an explicit opt-in at publish ("also start for the N accounts that already match"), audited, off by default, subject to the same caps.
- **D-132 (D5):** A draft step is `mode: "agent"` (the Outreach agent) or `mode: "template"`. A template is inline text with a closed merge-field set plus `{{metric.*}}` placeholders, checked by the M7 placeholder validator and a sensitive-word scan. Publish freezes the text; there is no template table.
- **D-133 (D6):** A play definition has an optional `segmentId`. The safety check refuses a deleted segment or one whose filter excludes the play's tier/branch. Segment membership is evaluated as a read-only system computation (like the nightly pipeline); it grants no permissions — steps still pass dispatch and approvals normally.
- **D-134 (D7):** For an auto-send step, the runner records an Approval row (level `SEND_AUTOMATICALLY`, status `AUTO_RECORDED`, hidden from queues) so dispatch's proof pre-check passes WITHOUT modifying `dispatch.ts`. If dispatch guards hold the message, it converts to `PENDING` `DRAFT_FOR_APPROVAL`.
- **D-135 (D8):** Campaigns belong to Session 2. Built in S13/S14 with `ApprovalKind.CAMPAIGN`, recipient list, and dispatch campaign mode.
- **D-136 (D9):** 15 seeded plays: Champion Loss is LIVE on `contact_bounced_or_left` + `power_user_quiet`. Dormant plays (labelled, cannot activate): Promise Late (M9), Engagement Loss (M9/M10), QBR Due (M10), Business Review Follow-up (M10). Cancellation Save triggers on `noteTag: "cancellation-risk"`. Schedule and segmentEntry triggers run off a nightly scan with triggerRef making entry once-only.
- **D-137 (D10):** For onboarding stall, adoption, renewal window and expansion triggers, a play's draft step DELEGATES to the existing M6/M7 agent — never a second draft. The M6/M7 sweeps skip accounts that have a published play run.
- **D-138 (D11):** Play-builder is an `AgentRun`-audited assistant in the AI team, not a spec agent; it outputs only DRAFT plays and never publishes directly.
- **D-139 (D12):** Plan adoption into `Renewal.planSteps` is a human-only action on the Renewal Brief page. Narrative editor is OUT of M8 (homed to M10).
- **D-140 (Dead Play Definition):** A published play that sees zero run entries across its configured window (default 30 days) is flagged as a dead play with an amber badge in the UI and a clear explanation. It is NEVER automatically deactivated or killed by background jobs; deactivation remains an explicit human decision.
- **D-141 (Campaign Approval Decision Rights):** Only `ADMIN` or `CS_LEADER` roles may approve a campaign approval (`ApprovalKind.CAMPAIGN`). A standard CSM attempting to approve is refused with `ForbiddenError("approvals:decide", "Only an Admin or CS Leader may decide a campaign approval")`.
- **D-142 (Deterministic Proposed Plays):** The Setup wizard "Proposed plays" step utilizes 100% deterministic rule matching (inspecting connected integrations, account tiers, and usage volumes) with zero LLM dependence to prevent hallucinations in foundational customer workflows.

---

## Standing Pre-Approval Test Updates Logged

As explicitly pre-approved by founder instructions, the following existing count and registry assertions were updated to accommodate M8 additions while underlying invariants held intact:

1. **Setup Wizard Step Count:**
   - File: `src/modules/setup/__tests__/setup.int.test.ts`
   - Old: `"Step 1 of 5"`
   - New: `"Step 1 of 6"`
   - Reason: Insertion of the mandatory "Proposed plays" step before Go Live.

2. **Registered Agents Registry:**
   - File: `src/modules/agents/__tests__/agent-registry.test.ts`
   - Old: 8 agents registered
   - New: 10 agents registered (added `digital-csm` and `play-builder`)
   - Reason: S9 added `digital-csm` and S10 added `play-builder` assistant to the AI team.

---

## Fresh Scratch Database Demo Verification

Executed via `scripts/demo-fresh-db.ts` on a newly created, fully migrated scratch database (`nexaworks_scratch_m8_*`):

1. **Scenario 1 — Champion Loss Run:** Published seeded Champion Loss play; triggered with account; created `PlayRun` `RUNNING`, step `draft-reconnect` transitioned to `WAITING_APPROVAL`, step `task-champion` completed `DONE`. Log transport verified.
2. **Scenario 2 — Promise Late Refusal:** Attempted publish on dormant play Promise Late; rejected with `status = REFUSED` and message `"Trigger promise_late has no detector yet (Promise Tracker, M9)."`. Play status remained `DRAFT`.
3. **Scenario 3 — Orchard Lane Frequency Cap:** Executed step against recently emailed contact; step marked `SKIPPED` with reason `"This contact was emailed 2 hours ago (limit 72)."`. Exactly 0 tasks created.
4. **Scenario 4 — Campaign Approval & Send:** Created bulk campaign; approved by Admin; executed batch of 3 recipients: 2 sent (`SENT`), 1 suppressed held (`HELD` with `"The address is on the suppression list (unsubscribed)."`).
5. **Scenario 5 — Renewal Plan Adoption:** Adopted 3 proposed brief steps into `Renewal.planSteps`; verified persisted JSON array with timestamps, details, and adopting membership ID.

Scratch database was dropped cleanly post-verification.

---

## Homing of Deferrals

- **Live Resend Webhook Verification:** DEFERRED (item 17). Verified via mock Svix/Resend payload signatures and local log transport; live external provider sandbox testing deferred until credentials provided.
- **Dormant Plays (M9 & M10):**
  - Promise Late (`promise_late` detector) → **M9**
  - Engagement Loss (`engagement_loss` detector) → **M9 / M10**
  - QBR Due (`qbr.due` detector) → **M10**
  - Business Review Follow-up (`business_review.followup` detector) → **M10**
- **Narrative Editor in UI:** Homed to **M10** per D-139.
- **Ask-AI Enrollment into Plays:** Homed to **M11**.

---

## Regression Statement

- **M7 Baseline:** 181 test files / 1,704 tests passed; Playwright E2E 71 passed / 0 failed / 53 skipped.
- **M8 Session 1 Close:** 190 test files / 1,780 tests passed; Playwright E2E 75 passed / 0 failed / 55 skipped.
- **M8 Final Close:**
  - `pnpm gate`: **200 test files / 1,840 tests passed (100% GREEN)**
  - `pnpm test:e2e`: **75 passed / 0 failed / 55 skipped (100% GREEN)**
  - Zero pre-M8 test regressions.
  - Net increase of +19 test files and +136 tests across unit and integration suites.
