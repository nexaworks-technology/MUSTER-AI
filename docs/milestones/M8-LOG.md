# M8 — Plays Engine: Log

**Status:** **Session 1 Complete (2026-11-05): Slices S1–S8 committed; single full test suite executed.**

---

## Session 1 Slices Committed

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

---

## Decisions Recorded (D-128 through D-139 in `docs/DECISIONS.md`)

- **D-128 (D1):** A frequency-cap breach at run time makes the step SKIPPED with the reason recorded on the run (never queued, never sent). All other guards still HELD → Approvals at dispatch. No task is created for a skip.
- **D-129 (D2):** A run is unique on `(workspaceId, playId, accountId, triggerRef)`. The play version is recorded on the run; at most one OPEN run (`RUNNING` or `WAITING`) per play+account; a second trigger while one is open is ignored and logged.
- **D-130 (D3):** Outbox routes may fan out to several jobs, but existing single routes stay byte-identical. Added `approval.decided` and `note.created` events. A data migration marks pre-M8 backlog events processed (no history flood). Runs enter only for signals first seen after publish.
- **D-131 (D4):** Retroactive entry is an explicit opt-in at publish ("also start for the N accounts that already match"), audited, off by default, subject to the same caps.
- **D-132 (D5):** A draft step is `mode: "agent"` (the Outreach agent) or `mode: "template"`. A template is inline text with a closed merge-field set plus `{{metric.*}}` placeholders, checked by the M7 placeholder validator and a sensitive-word scan. Publish freezes the text; there is no template table.
- **D-133 (D6):** A play definition has an optional `segmentId`. The safety check refuses a deleted segment or one whose filter excludes the play's tier/branch. Segment membership is evaluated as a read-only system computation (like the nightly pipeline); it grants no permissions — steps still pass dispatch and approvals normally.
- **D-134 (D7):** For an auto-send step, the runner records an Approval row (level `SEND_AUTOMATICALLY`, status `AUTO_RECORDED`, hidden from queues) so dispatch's proof pre-check passes WITHOUT modifying `dispatch.ts`. If dispatch guards hold the message, it converts to `PENDING` `DRAFT_FOR_APPROVAL`.
- **D-135 (D8):** Campaigns belong to Session 2. No campaign schema or UI built in Session 1.
- **D-136 (D9):** 15 seeded plays: Champion Loss is LIVE on `contact_bounced_or_left` + `power_user_quiet`. Dormant plays (labelled, cannot activate): Promise Late (M9), Engagement Loss (M9/M10), QBR Due (M10), Business Review Follow-up (M10). Cancellation Save triggers on `noteTag: "cancellation-risk"`. Schedule and segmentEntry triggers run off a nightly scan with triggerRef making entry once-only.
- **D-137 (D10):** For onboarding stall, adoption, renewal window and expansion triggers, a play's draft step DELEGATES to the existing M6/M7 agent — never a second draft. The M6/M7 sweeps skip accounts that have a published play run.
- **D-138 (D11):** Play-builder (Session 2) is recorded as an amendment to D-30: an `AgentRun`-audited assistant in the AI team, not a spec agent; it never publishes.
- **D-139 (D12):** Plan adoption into `Renewal.planSteps` is Session 2. The narrative editor is OUT of M8 (homed to M10).

---

## Test Edits Logged

- **Existing test files modified:** None. Zero existing test files were loosened, skipped, or edited. All pre-existing test suites and counts remain intact.
- **Full test execution:** Exactly one full `pnpm test` was run at the end of Session 1 across 190 test files, reporting 1,780 passed tests. The single failure in `renewal-manager.int.test.ts` (caused by S1's foreign key check on mock signal IDs) was fixed in-session (`53ed8c4`) and re-run green (7/7 passed).

---

## Deferrals to Session 2 & Future Milestones

- **Session 2 Scope:**
  - Campaigns engine and schema (`Campaign`, campaign steps, CSV audience, approvals).
  - Play-builder agent (interactive conversational drafting via `AgentRun`).
  - Plan adoption UI into `Renewal.planSteps`.
  - Setup wizard "Proposed plays" step.
  - End-to-end demo `e2e/m8-plays.spec.ts` and milestone verification.
- **Deferred to M9:**
  - Promise Late play activation (awaits `promise_late` detector in M9).
  - Engagement Loss play activation (awaits `engagement_loss` detector in M9/M10).
- **Deferred to M10:**
  - QBR Due play activation (awaits `qbr.due` detector in M10).
  - Business Review Follow-up play activation (awaits `business_review.followup` detector in M10).
  - Narrative editor in UI (homed to M10 per D-139).
- **Deferred to M11:**
  - Ask-AI enrollment into plays.

---

## State Summary for Session 2

Session 1 has completed and committed slices S1 through S8, establishing the entire underlying Plays engine: database models (`Play`, `PlayVersion`, `PlayRun`, `PlayStepRun`), pre-publish safety gate (`safety.ts`), step resolver and runtime cap enforcement, runner with 7 step handlers and BullMQ integration, guarded auto-send enablement with typed confirmation, the 15 seeded plays (11 live and 4 dormant naming their future milestone detectors), and the `/plays` management UI with inspection, duplicate, pause, kill, version history, and D4 retroactive entry opt-in. All sends route strictly through the unmodified `src/modules/outbound/dispatch.ts` choke point via the D7 `AUTO_RECORDED` proof path. The repository is in a clean, fully-tested state ready for Session 2 to implement the Campaigns schema and worker, the Play-builder AI assistant, Renewal plan adoption, the setup wizard proposed plays step, and the final e2e suite.
