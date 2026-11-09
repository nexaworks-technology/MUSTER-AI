# DESIGN 2.0 ROLLOUT — Session 2 (Final): All Remaining Screens

**Milestone**: Design 2.0 Rollout — Session 2 (Final)  
**Target Class**: Modern premium SaaS (Linear / Attio / Vitally class)  
**Date**: November 7, 2026  
**Status**: COMPLETE  

---

## 1. Overview & Objectives

Following Session 1 ([`DESIGN2-ROLLOUT-LOG.md`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/DESIGN2-ROLLOUT-LOG.md)), Session 2 completes the Design 2.0 rollout across all remaining surfaces in the platform:
1. **R1 — Work screens**: Approvals (`/approvals`, `/approvals/[id]`) and Tasks (`/tasks`) adopting the DataList card pattern, StatusPill tokens, monogram avatars, and clear approve/decline action hierarchy.
2. **R2 — Portfolio screens**: Onboarding (`/onboarding`), Renewals (`/renewals`), Expansion (`/expansion`), and Revenue (`/revenue`) adopting the data-grid pattern with sticky headers, compact rows, single-card filters, exact tabular money figures, and pagination footers.
3. **R3 — Automation + Insight**: Plays (`/plays`), Inbox (`/inbox`), Promises (`/promises`), Meetings (`/meetings/qbr/[id]`), Reports (`/reports`), and Ask AI (`/ask`, `/ask/[threadId]`) with premium chat bubbles, pill-styled citation chips, composer bar, and preserved proposal cards.
4. **R4 — Home, Settings, Sign-in**: Home (`/`) as a dashboard card surface, Settings (`/settings/*`) with unified component tokens and Account 360 tab pattern, and Sign-in (`/sign-in`) as a centered branded card with logo tile.
5. **R5 — Customer-facing alignment**: Customer Portal (`/portal/[token]`) and Public Survey (`/s/[token]`) re-checked and aligned with final elevation, card borders, radius, and status pills.

### Core Principles
- **Layout changes permitted**: Premium card containers, data grids, sticky headers, segmented nav controls, and layered elevation surfaces.
- **Behaviour, data, and copy meaning strictly preserved**: Zero invented metrics, deltas, or sparklines. Exact tabular numbers for money and dates.
- **Strict Accessibility & Test IDs**: Preserved every `data-testid`, ARIA label, accessible name, form field name, route, and permission check.
- **Zero Stopped Specs**: All targeted specs ran cleanly without modifying assertions.

---

## 2. Implementation Summary

### R1 — Work Screens (`/approvals`, `/approvals/[id]`, `/tasks`)
- **Approvals List (`src/components/app/bulk-approvals.tsx`, `src/app/(app)/approvals/page.tsx`)**:
  - Segmented control tabs for `Pending` and `Decided`.
  - Rows wrapped in `DataListCard` with account monogram avatars (`DataListAvatar`), `StatusPill` for approval levels/sensitive banners, and hover row highlighting.
  - Clear bulk action hierarchy: Primary `Button` for "Approve selected" vs secondary outline for "Reject selected".
  - Preserved `data-testid="approval-row"`, `data-testid="sensitive-badge"`, `data-testid="decided-row"`, checkboxes, and pagination.
- **Single Approval (`src/app/(app)/approvals/[id]/page.tsx`, `src/components/app/approval-actions.tsx`)**:
  - Elevated section cards with layered borders and soft shadows.
  - Approve action hierarchy: Primary "Approve and send", secondary outline "Reject", and tertiary "Edit before approving".
- **Tasks (`src/components/app/task-list.tsx`, `src/app/(app)/tasks/page.tsx`)**:
  - Segmented control navigation for `Open` and `Done`.
  - Task rows wrapped in `DataListCard` with monogram avatars, `StatusPill` for "Overdue" and "Done" states, hover row actions for task completion, and preserved `data-testid="task"`.

### R2 — Portfolio Screens (`/onboarding`, `/renewals`, `/expansion`, `/revenue`)
- **Onboarding (`src/app/(app)/onboarding/page.tsx`)**:
  - Single-card filter bar with styled selects.
  - Data grid table with sticky header (`sticky top-0 bg-muted/60 backdrop-blur-sm`), compact rows, `DataListAvatar` monograms, `StatusPill` for Stalled/On track, and styled pagination footer.
- **Renewals (`src/app/(app)/renewals/page.tsx`)**:
  - Filter card with window, confidence, and owner dropdowns.
  - Forecast card section with tabular exact currency figures.
  - Table with sticky header, compact rows, monogram avatars, confidence `StatusPill` (`healthy` / `watch` / `atRisk`), exact tabular ARR figures, and styled pagination footer.
- **Expansion (`src/app/(app)/expansion/page.tsx`)**:
  - Filter card and opportunity cards wrapped in modern elevation surfaces.
  - Styled pagination footer.
- **Revenue (`src/app/(app)/revenue/page.tsx`)**:
  - ARR waterfall table in elevated card with exact tabular figures.
  - Money at risk, expected billing, coverage, and team load sections in `DataListCard` containers with compact rows and tabular numbers.

### R3 — Automation + Insight (`/plays`, `/inbox`, `/promises`, `/meetings`, `/reports`, `/ask`)
- **Plays (`src/app/(app)/plays/page.tsx`)**:
  - Subnav tabs styled with active indicator line.
  - Interactive play cards with `StatusPill` for DRAFT, PUBLISHED, PAUSED, KILLED statuses.
- **Inbox (`src/app/(app)/inbox/page.tsx`)**:
  - Segmented control navigation for `Open`, `All`, and `Unmatched`.
  - Inbound messages wrapped in `DataListCard` with account monograms, `StatusPill` for source types and statuses, and preserved action controls.
- **Promises (`src/components/app/promise-table.tsx`, `src/app/(app)/promises/page.tsx`)**:
  - Segmented view tabs.
  - Table wrapped in `DataListCard` with monogram avatars, `StatusPill` for LATE, BROKEN, OPEN, KEPT with preserved `data-testid="promise-status"`.
- **Meetings & QBR (`src/app/(app)/meetings/qbr/[id]/page.tsx`)**:
  - Metrics table with sticky header and tabular values.
  - Narrative blocks wrapped in elevated `DataListCard` containers.
- **Reports (`src/app/(app)/reports/page.tsx`)**:
  - Pre-made reports and proof sections wrapped in `DataListCard` with subtle hover lift.
- **Ask AI (`src/app/(app)/ask/layout.tsx`, `src/app/(app)/ask/[threadId]/page.tsx`, `src/components/app/ai-text.tsx`, `src/components/app/ask-box.tsx`)**:
  - Thread navigation sidebar with "+ New question" button and styled thread cards.
  - User messages formatted as modern right-aligned chat bubbles (`bg-primary text-primary-foreground rounded-2xl rounded-tr-sm`).
  - AI responses rendered in elevated card bubbles with citation chips styled as pills (`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border border-border/70 bg-muted/50 hover:bg-muted text-foreground transition-colors`).
  - Composer bar (`AskBox`) with rounded borders, focus rings, and streamlined attachment/dictation controls.
  - Preserved proposal cards (`ApprovalCard`) and action executions.

### R4 — Home, Settings, Sign-in (`/`, `/settings/*`, `/sign-in`)
- **Home (`src/app/(app)/page.tsx`)**:
  - Header featuring workspace tile monogram.
  - "Your access" and "Workspace" definition list cards with status pills for roles and access permissions.
- **Settings (`src/app/(app)/settings/tab-nav.tsx`, `src/app/(app)/settings/layout.tsx`)**:
  - Added `SettingsTabNav` mirroring Account 360's tab bar with active indicator underline, subtle active background, and responsive horizontal scroll.
- **Sign-in (`src/app/sign-in/page.tsx`)**:
  - Centered branded card (`surface-card rounded-2xl border border-border/80 p-8 shadow-sm max-w-sm`) featuring a bold logo tile (`size-11 rounded-xl bg-primary text-primary-foreground font-bold`), `{PRODUCT_NAME}` heading, and Google SSO button.

### R5 — Customer-Facing Alignment (`/portal/[token]`, `/s/[token]`)
- **Customer Portal (`src/app/portal/[token]/page.tsx`)**:
  - Aligned with layered elevation, rounded-xl cards, subtle borders, and `StatusPill` for shared plan statuses.
- **Public Survey (`src/app/s/[token]/page.tsx`, `src/app/s/[token]/survey-form.tsx`)**:
  - Aligned with rounded-2xl surface card, pill radio chips for score selection, rounded textarea, and clean button styling.

---

## 3. Real Data Sources & Integrity

All visualised numbers originate strictly from existing queries and code:
- **Revenue & Renewals**: All ARR, opening/closing movements, billing schedules, and confidence scores are rendered verbatim with `tabular-nums` formatting without currency conversion or synthetic projections.
- **Onboarding TTV**: Days and verdicts computed strictly from account history records.
- **Ask AI Citations**: Citations link directly to real underlying database records with verified permissions.

---

## 4. Before & After Screenshot Inventory

Screenshots captured against the production build with seeded demo data:

| Slice | Representative Screen | Viewport | Before Screenshot | After Screenshot |
|---|---|---|---|---|
| **Slice 1: Work** | Approvals (`/approvals`) | Desktop (1440×900) | [`before/approvals-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/approvals-desktop.png) | [`after/approvals-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/approvals-desktop.png) |
| **Slice 1: Work** | Approvals (`/approvals`) | Mobile (375×812) | [`before/approvals-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/approvals-mobile-375.png) | [`after/approvals-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/approvals-mobile-375.png) |
| **Slice 2: Portfolio** | Renewals (`/renewals`) | Desktop (1440×900) | [`before/renewals-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/renewals-desktop.png) | [`after/renewals-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/renewals-desktop.png) |
| **Slice 2: Portfolio** | Renewals (`/renewals`) | Mobile (375×812) | [`before/renewals-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/renewals-mobile-375.png) | [`after/renewals-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/renewals-mobile-375.png) |
| **Slice 3: Automation** | Ask AI (`/ask`) | Desktop (1440×900) | [`before/ask-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/ask-desktop.png) | [`after/ask-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/ask-desktop.png) |
| **Slice 3: Automation** | Ask AI (`/ask`) | Mobile (375×812) | [`before/ask-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/ask-mobile-375.png) | [`after/ask-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/ask-mobile-375.png) |
| **Slice 4: Settings** | Workspace (`/settings/workspace`) | Desktop (1440×900) | [`before/settings-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/settings-desktop.png) | [`after/settings-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/settings-desktop.png) |
| **Slice 4: Settings** | Workspace (`/settings/workspace`) | Mobile (375×812) | [`before/settings-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/settings-mobile-375.png) | [`after/settings-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/settings-mobile-375.png) |
| **Slice 4: Sign-in** | Sign In (`/sign-in`) | Desktop (1440×900) | [`before/signin-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/signin-desktop.png) | [`after/signin-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/signin-desktop.png) |
| **Slice 4: Sign-in** | Sign In (`/sign-in`) | Mobile (375×812) | [`before/signin-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/signin-mobile-375.png) | [`after/signin-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/signin-mobile-375.png) |
| **Slice 5: Survey** | Survey Feedback (`/s/[token]`) | Desktop (1440×900) | [`before/survey-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/survey-desktop.png) | [`after/survey-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/survey-desktop.png) |
| **Slice 5: Survey** | Survey Feedback (`/s/[token]`) | Mobile (375×812) | [`before/survey-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/before/survey-mobile-375.png) | [`after/survey-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout2/after/survey-mobile-375.png) |

---

## 5. Stopped Specs & Discrepancies

**None.**  
All targeted specs ran to completion and passed cleanly without modifying any test assertions. All accessibility tests passed with zero WCAG 2.1 AA violations.

---

## 6. Verification & Test Suite Summary

- **TypeScript Compilation**: `pnpm typecheck` passed (0 errors)
- **Linting**: `pnpm lint` passed (0 errors, 0 warnings across 1,615 files)
- **Production Build**: `pnpm build` passed (Next.js 16.4.3 production build succeeded in 4.7s)
- **Targeted E2E Specs**:
  - `e2e/m4-today-approvals.spec.ts`: PASSED (7 passed, 7 skipped; verified both recorded AI & AI-off runs)
  - `e2e/m7-renewals-revenue.spec.ts`: PASSED (9 passed, 9 skipped; verified both recorded AI & AI-off runs)
  - `e2e/m1-foundation.spec.ts`: PASSED (2 passed, 2 skipped; verified both recorded AI & AI-off runs)
  - `e2e/m9-inbox-promises.spec.ts`: PASSED (10 passed, 0 failed; verified both recorded AI & AI-off runs)
  - `e2e/m11-ask-ledger.spec.ts`: PASSED (10 passed, 10 skipped; verified both recorded AI & AI-off runs)
- **Full Accessibility Suite**:
  - `e2e/a11y.spec.ts`: PASSED (8 passed: 4 desktop + 4 mobile viewports; verified both recorded AI & AI-off runs with 0 axe violations)

