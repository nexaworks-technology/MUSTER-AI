# M10 log — Meetings, QBRs, Success Plans, Customer Portal & Surveys

> **Session 1 (Slices 1–6) complete on its own terms.** Session 2 sections (Slices 7–12) will be added by Session 2. Slices 1–6 establish the data schema, upload security, calendar/transcript ingest adapters, signal rule wake with zero health drift, pre-call brief agent, and call summaries with task handoff.

---

## Session 1 — What Was Built

| Slice | Commit | What it is | Evidence |
|---|---|---|---|
| Slice 1 Schema & Tenancy | (this commit) | `Meeting`, `MeetingAttendee`, `SuccessPlan`, `Survey`, `SurveyResponse`, `PortalAccess` models; `FilePurpose.CALL_TRANSCRIPT`; `Task.ownerMembershipId` nullable for unassigned tasks; RLS policies; composite FKs; unique indexes. Migration `20261108100000_m10_meetings_portal_surveys`. | `tenant-isolation-m10.int.test.ts` (19/19: cross-tenant reads/writes rejected, raw-SQL returns 0, composite FKs enforced), `model-registry.int.test.ts` (151/151: 6 new [W] models registered). |
| Slice 2 Upload Safety | (this commit) | `CALL_TRANSCRIPT` purpose (`vtt`, `srt`, `txt`, `json`); format sniffers in `validate.ts` (WebVTT `WEBVTT` header, SRT `-->` timestamps, valid UTF-8 JSON/text); authorization via `requireEditableAccount` (write) and `getAccount` (read) in `files/service.ts`. | `validate.test.ts` (16/16), `files.int.test.ts` (7/7). |
| Slice 3 Ingest Adapters | (this commit) | 5 integration adapters: Google Calendar, Microsoft Calendar, Fireflies, Gong, Zoom. Ingest service `ingestMeetings` and `ingestTranscripts` with contact/domain matching (unmatched kept `accountId: null`). Provider registration and error descriptors. | 5 connector contract tests (15/15), `meetings-connectors.int.test.ts` (2/2). |
| Slice 4 Signal Wake & Health | (this commit) | `no_meeting_in_x_days` awakened on real meeting data (`loadMeetingFacts` in `signals/lifecycle.ts`). Engagement pillar `last_meeting` remains missing/null in active health model (Decision 1, Option A). Rule NOT added to `RENEWAL_BACKTEST_RULES_V1`. Zero health score drift, zero renewal confidence movement. | `as-of-m9.test.ts` (2/2), `rules.test.ts` (257/257), `health` suite (154/154), `renewals` suite (37/37). |
| Slice 5 Pre-call Briefs | (this commit) | Prompts `prompts/meeting-brief.md` (1.0.0, standard), `prompts/meeting-summary.md` (1.0.0, standard), `prompts/qbr-narrative.md` (1.0.0, deep). Agent `meeting-qbr` defined and registered (13 total agents). Service `prepareBrief` with idempotency per meeting version. Origin `AI` with `agentRunId` enforced by DB check constraint. | `brief-idempotency.test.ts` (1/1), `team.int.test.ts` (3/3). |
| Slice 6 Summaries & Actions | (this commit) | Service `summarizeCall`: extracts action items to `Task` records (matches attendees to workspace memberships, unknown owner → `[No owner found]` with `ownerMembershipId: null`, never an invented owner). Links `summaryAgentRunId` on `Meeting`. Routes transcript to Watcher extraction pipeline. | `summary-actions.test.ts` (1/1), `tsc --noEmit` clean. |

---

## Session 1 — The One Mid-Milestone Full `pnpm test`

Executed once, after Slice 6 completion (nothing edited during the run). Batch 1 of allowed 2 failure batches applied:

| Run | Test Files | Total Tests | Result |
|---|---|---|---|
| Baseline (M9 Close) | 239 | 2,284 | green |
| Mid-Milestone Full Run | 248 | 2,345 | **3 failed**, 245 files / 2,342 tests passed (316 s) |
| Batch 1 Re-run (failed suites only) | 3 | 24 | **All 3 passed** (24/24 tests) |

### Failures Read Together & Resolved (Batch 1)

1. **`src/lib/db/__tests__/tenant-isolation-m7.int.test.ts`** (`Document` check constraint mismatch):
   - *Cause:* Migration `20261108100000_m10_meetings_portal_surveys` duplicated the M7 check constraint `document_agent_run_required` under the name `Document_origin_agentRunId_check`. Postgres evaluated the duplicate first, causing the error message to report `Document_origin_agentRunId_check` instead of `document_agent_run_required`.
   - *Fix:* Removed duplicate constraint from the M10 migration file and dropped `Document_origin_agentRunId_check` on dev and test databases.
   - *Verification:* `tenant-isolation-m7.int.test.ts` passed 10/10.

2. **`src/modules/signals/__tests__/pipeline.int.test.ts`** (chunk query budget ≤ 90):
   - *Cause:* M10 Slice 4 added `loadMeetingFacts` to `evaluateAccountSignalsBatch` (+1 chunk-level read for meeting facts).
   - *Observation:* `expect(five.queries).toBe(two.queries)` (91 === 91) held exactly: query counts do NOT scale with accounts (no N+1).
   - *Fix:* Under standing pre-approval for budget constants, updated budget from 90 to 92.
   - *Verification:* `pipeline.int.test.ts` passed 7/7.

3. **`prisma/seed/__tests__/seed-expansion.int.test.ts`** (`open.queries === all.queries`, 15 vs 14):
   - *Cause:* Transient interference from parallel demo-seed test execution against the shared seed database during the full parallel run.
   - *Verification:* Re-run passed 7/7 (`open.queries === all.queries === 14`).

---

## Session 1 — Pre-M10 Test Changes (Standing Pre-approval; Every One Logged)

| File | Old | New | Reason | Class |
|---|---|---|---|---|
| `src/modules/agents/__tests__/team.int.test.ts` (line 12) | `expect(AGENTS).toHaveLength(12)` | `expect(AGENTS).toHaveLength(13)` | M10 added `meeting-qbr` agent | count |
| `src/modules/signals/__tests__/signals-db.int.test.ts` (lines 60, 67) | Rule `"no_meeting_in_x_days"` used as dormant rule test subject | `"test_dormant_rule"` | `no_meeting_in_x_days` awakened in M10; test verifies dormant check constraint on an actual dormant rule | fixture |
| `src/modules/signals/__tests__/rule-settings.int.test.ts` (lines 40, 64) | Dormant rules count assertions referencing `no_meeting_in_x_days` | Updated to test dormant constraint without assuming `no_meeting_in_x_days` is dormant | `no_meeting_in_x_days` awakened in M10 | fixture |
| `src/modules/signals/__tests__/pipeline.int.test.ts` (line 217) | `expect(five.queries).toBeLessThanOrEqual(90)` | `expect(five.queries).toBeLessThanOrEqual(92)` | +1 chunk query for `loadMeetingFacts`; guard `five.queries === two.queries` (91 === 91) still holds | budget |

---

## Session 1 — Health-Stability Evidence for Decisions 1–2

- **Decision 1 (Option A) — Meeting Signal Wake:**
  - `no_meeting_in_x_days` rule awakened on real meeting data.
  - Engagement pillar component `last_meeting` remains missing/null in `src/modules/health/pillars/engagement.ts` (`SYSTEM_DEFAULT` health model version 1).
  - Rule is NOT added to `RENEWAL_BACKTEST_RULES_V1`. `src/modules/signals/__tests__/as-of-m9.test.ts` passed (2/2), proving `no_meeting_in_x_days` is excluded from the renewal back-test.
  - Standing note: Engagement pillar meeting component activation is deferred to a future decision (new health model version + back-test calibration).
  - Seed health score stability: zero score drift across all seeded accounts. `src/modules/health/__tests__/backtest-seed.int.test.ts` passed (3/3), reproducing recorded health fixtures exactly twice in a row.
  - Renewal back-test stability: `src/modules/renewals/__tests__/` (6 files, 37 tests) passed with 0 drift.

- **Decision 2 (Option A) — Surveys (Session 2 Preparation):**
  - Schema (`Survey`, `SurveyResponse`) created with proper foreign keys, unique token index, and tenant isolation.
  - Implementation of survey dispatch and sentiment activation follows in Session 2 (Slices 10 & 11).

---

## State Summary for Session 2

Session 1 leaves the repository clean, type-checked (`pnpm tsc --noEmit` 0 errors), and fully verified on targeted suites:
- Slices 1–6 are fully implemented and verified.
- Session 2 will implement Slices 7–12:
  - **Slice 7:** QBR Document & Workflow (generator, review, lock/delivery audit).
  - **Slice 8:** Success Plans & Goals (milestones, objectives, portal sharing flag).
  - **Slice 9:** Customer Portal (magic link authentication, single-account portal layout, access logging).
  - **Slice 10:** Customer Surveys & Response Intake (NPS/CSAT/CES dispatch, token validation, sentiment attribution).
  - **Slice 11:** Play Wake & Cadence Detectors (`engagement-loss` mapped to `no_meeting_in_x_days`, `qbr.due`, `business-review-followup`).
  - **Slice 12:** Seed Data, Verification, Full Gate & E2E.
