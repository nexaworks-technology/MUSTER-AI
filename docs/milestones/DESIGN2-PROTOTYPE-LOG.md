# DESIGN 2.0 PROTOTYPE — Shell + Today

**Milestone**: Design 2.0 Prototype (Shell + Today only)  
**Target Class**: Modern premium SaaS (Linear / Attio / Vitally class)  
**Date**: November 6, 2026  
**Status**: COMPLETE  

---

## 1. Overview & Objectives

This prototype delivers the Design 2.0 aesthetic foundation across the global app shell and the primary workspace dashboard (**Today**).

### Core Principles
- **Layout changes permitted**: Grouped sidebar, layered elevation surfaces, dashboard KPI row, card-based section presentation, and shared premium data patterns.
- **Behaviour, data, and copy meaning strictly preserved**: Zero invented metrics, deltas, or sparklines. Every number displayed originates from real existing domain queries.
- **Strict Accessibility & Test IDs**: Preserved all `data-testid`, ARIA labels, accessible names, roles, routes, and permission scopes.
- **No silent spec edits**: Specs tied to the legacy flat layout were stopped and documented with old vs. needed assertions.

---

## 2. Implementation Summary

### S1 — Shell (`src/app/(app)/layout.tsx`)
- **Lucide Icons**: Integrated Lucide icons for all navigation items (`lucide-react@1.66.0` was already present as a dependency).
- **Grouped Sidebar Sections**:
  - **Work**: Home, Today, Approvals, Tasks
  - **Portfolio**: Accounts, Health, Onboarding, Renewals, Expansion, Revenue
  - **Automation**: Plays, Inbox, Promises
  - **Insight**: Reports, Ask AI
  - *Permission-Aware*: Sections and individual items render only when permitted by `visibleNav(ctx)`.
- **Pinned Settings**: Settings is pinned at the bottom of the navigation region above the user card.
- **Workspace Card (Top)**:
  - Accent tile holding the workspace initial mark.
  - Workspace title and product name.
  - Form-based workspace switcher preserved when the user belongs to multiple workspaces.
- **User Card (Bottom)**:
  - Initials avatar chip (`DataListAvatar` / `getInitials`).
  - User name and formatted role label (`ROLE_LABELS[ctx.role]`).
  - Sign-out action button with form action preserved.
- **Top Bar**:
  - `TopBarBreadcrumb` (`src/components/app/breadcrumb.tsx`): Dynamic workspace and route breadcrumb.
  - Visual Search Shell: Search input placeholder (`Search accounts, plays...`) with `⌘K` keyboard hint chip (non-functional shell).
  - Restyled notification bell with `unread > 0` pill count (`data-testid="unread-count"`).
  - Restyled user label and sign-out controls.

### S2 — Surfaces & Elevation (`src/app/globals.css`)
- **Layered Elevation**:
  - `--background` set to `oklch(0.978 0.005 85)`: exactly one step darker than pure white card surfaces (`--card: oklch(1 0 0)`).
  - High WCAG AA contrast maintained (foreground vs background ~16.5:1).
- **Card Surfaces & Shadows**:
  - Subtle borders: `--border: oklch(0.912 0.007 80)`.
  - Refined soft shadow scale: `--shadow-xs`, `--shadow-sm`, `--shadow-md`.
  - `@utility surface-interactive`: Subtle lift on hover (`transform: translateY(-1px)`, `box-shadow: var(--shadow-sm)`).
- **Typography & Formatting**:
  - Headings (`h1-h6`): tight tracking (`letter-spacing: -0.02em`).
  - UI text scaled at 13–14px (`text-xs` / `text-sm`).
  - Numbers maintain tabular alignment (`font-variant-numeric: tabular-nums`).

### S3 — Today Dashboard (`src/app/(app)/today/page.tsx`)
- **Header Row**:
  - Time-aware personalized greeting ("Good morning / afternoon / evening, [First Name]").
  - Formatted calendar date in the workspace timezone.
  - Primary action buttons: `Approvals` (with pending count chip) and `+ New task`.
  - Original description and revenue access notice preserved verbatim.
- **KPI Stat Row**:
  - 4 interactive stat cards in a responsive grid.
  - Strict rule compliance: Every stat is backed by real queries; stats without time series data are displayed without trends.
- **Restyled Today Sections**:
  - Each section wrapped in `DataListCard` with clear headers, badge counters `({s.total})`, and "View all" links to `/tasks`, `/health`, `/approvals`, `/renewals`.
  - Individual items display monogram chips (`DataListAvatar`), title links, account indicators, reason strings (`data-testid="today-reasons"`), and hover row action buttons.
  - Full-page empty state (`data-testid="today-empty"`) and section-level empty states preserved verbatim.

### S4 — Shared Data Pattern
- `src/components/app/data-list.tsx`: Reusable `DataListCard`, `DataListHeader`, `DataListBody`, `DataListRow`, `DataListRowActions`, `DataListAvatar`, and deterministic monogram generation (`getInitials`).
- `src/components/app/status-pill.tsx`: `StatusPill` with semantic soft-color variants and status indicator dots.
- `src/components/app/breadcrumb.tsx`: `TopBarBreadcrumb` client component for route breadcrumb navigation.

---

## 3. Real Data Sources & Trend Logging

Per user instruction: *"Every number shown must come from existing queries/code — never invent a metric, delta or sparkline; if a trend has no data source, show the stat without a trend and log it."*

| KPI Stat | Data Source | Trend Status | Reason for No Trend |
|---|---|---|---|
| **Approvals waiting** | `getToday(ctx).find(s => s.key === "APPROVAL").total` (scoped to assignee) | **Shown without trend** | Approvals are stored as point-in-time lifecycle records (`PENDING`, `APPROVED`, etc.). No historical daily time series of pending approval queue depth exists in the database. |
| **Accounts at risk** | `healthOverview(ctx).bands.AT_RISK.count` (scoped to book via `bookWhere`) | **Shown without trend** | Health band computation calculates the active snapshot under the current health model. While snapshots exist, no continuous time-series table of historical daily at-risk counts exists for this KPI card. |
| **Renewals due in 30 days** | `listRenewals(ctx, { days: 30 }).total` (scoped to book & open window) | **Shown without trend** | Contract renewal dates are future point-in-time deadlines; no historical trend query exists for this rolling window. |
| **ARR at risk** | `healthOverview(ctx).bands.AT_RISK.arrMinor` formatted via `formatMoney` (requires `canViewRevenue`) | **Shown without trend** | Represents the point-in-time contract value of at-risk accounts. If the member lacks revenue access, displays "Locked" with subtext "Revenue access required" to strictly honor M3/M11 revenue privacy. |

---

## 4. Stopped Specs & Founder-Approved Resolutions

Per user instruction: *"If an e2e assertion is tied to the old layout and cannot pass, STOP on that spec, log old vs needed assertion, continue everything else — never edit it silently."*

### `e2e/m1-foundation.spec.ts` (Resolved via Founder Approval)

During initial prototype verification, `e2e/m1-foundation.spec.ts` asserted the legacy linear M1-M11 navigation order. The spec was halted and flagged.

#### Founder Approval Received
The founder approved updating the expected nav order in `e2e/m1-foundation.spec.ts` (`navFor` lists used at line 38 / line 77 in original source, lines 61 and 100 in updated source) to the grouped order:
`Home, Today, Approvals, Tasks, Accounts, Health, Onboarding, Renewals, Expansion, Revenue, Plays, Inbox, Promises, Reports, Ask AI, Settings`.
Exact-list match (`toHaveText(navFor(...))`) stays strictly intact.

#### Comparison: Old vs. New Navigation Lists

##### 1. ADMIN Role (Full Navigation)
- **Old (Legacy Milestone Linear Order)**:
  ```json
  [
    "Home", "Today", "Approvals",
    "Accounts", "Tasks",
    "Health", "Onboarding", "Renewals", "Expansion",
    "Plays", "Inbox", "Promises",
    "Revenue",
    "Reports", "Ask AI", "Settings"
  ]
  ```
- **New (Design 2.0 Grouped Order: Work → Portfolio → Automation → Insight → Pinned Settings)**:
  ```json
  [
    "Home", "Today", "Approvals", "Tasks",
    "Accounts", "Health", "Onboarding", "Renewals", "Expansion", "Revenue",
    "Plays", "Inbox", "Promises",
    "Reports", "Ask AI", "Settings"
  ]
  ```
  *(Key shifts: `Tasks` grouped into Work before `Accounts`; `Revenue` grouped into Portfolio before `Plays`)*

##### 2. CSM Role (No Settings, No Revenue Access by default)
- **Old (Legacy Milestone Linear Order)**:
  ```json
  [
    "Home", "Today", "Approvals",
    "Accounts", "Tasks",
    "Health", "Onboarding", "Renewals", "Expansion",
    "Plays", "Inbox", "Promises",
    "Reports", "Ask AI"
  ]
  ```
- **New (Design 2.0 Grouped Order)**:
  ```json
  [
    "Home", "Today", "Approvals", "Tasks",
    "Accounts", "Health", "Onboarding", "Renewals", "Expansion",
    "Plays", "Inbox", "Promises",
    "Reports", "Ask AI"
  ]
  ```

#### Verification Post-Update
- Executed on production build via `pnpm test:e2e e2e/m1-foundation.spec.ts`.
- **Main run (recorded AI)**: PASSED (2/2 passed, 2.7s)
- **AI-off run**: PASSED (2/2 passed)
- Status: **CONFIRMED GREEN**.

---

## 5. Verification & Test Evidence

### Targeted E2E Suites
1. **`e2e/m4-today-approvals.spec.ts`**:
   - `[e2e] main run (recorded AI)`: **PASSED** (7/7 tests passed)
   - `[e2e] AI-off run`: **PASSED** (7/7 tests passed)
   - Verifies Leo's Today ranking, Halden reason regex, usage drop signal, meeting calendar fallback, Aisha's task filtering, and approval navigation.
2. **`e2e/a11y-m4.spec.ts`**:
   - `[e2e] main run (recorded AI)`: **PASSED** (2/2 tests passed)
   - `[e2e] AI-off run`: **PASSED**
   - Axe Core WCAG 2.1 AA audit on `/today`, `/approvals`, `/settings/audit`, `/settings/ai-team`, `/agent-runs`, `/`: **0 blocking violations**.
3. **`e2e/a11y.spec.ts`**:
   - `[e2e] main run (recorded AI)`: **PASSED** (8/8 tests passed on desktop and mobile)
   - `[e2e] AI-off run`: **PASSED**
   - Full accessibility compliance on sign-in, home, settings, and Account 360 tabs.
4. **`e2e/m8-plays.spec.ts`**: **PASSED** (4/4 tests passed)
5. **`e2e/m9-inbox-promises.spec.ts`**: **PASSED** (10/10 tests passed)
6. **`e2e/m7-renewals-revenue.spec.ts`**: **PASSED** (18/18 tests passed)
7. **`e2e/m3-health-signals.spec.ts`**: **PASSED** (18/18 tests passed)
8. **`e2e/m6-onboarding.spec.ts`**: **PASSED** (18/18 tests passed)
9. **`e2e/m1-foundation.spec.ts`**:
   - `[e2e] main run (recorded AI)`: **PASSED** (2/2 tests passed)
   - `[e2e] AI-off run`: **PASSED** (2/2 tests passed)
   - Verifies tenant isolation, invite flow, role permissions, and full grouped navigation match for Admin and CSM.

### Build & Quality Gates
- **Typecheck**: `pnpm typecheck` passed (Next.js route types generated + TypeScript noEmit 0 errors).
- **Lint**: `pnpm lint` passed with `--max-warnings=0` and 0 secrets detected across 1,610 files.
- **Prettier**: Prettier format verified on all modified files.
- **Production Build**: `pnpm build` passed (`next build` with Turbopack, 100% routes generated successfully).

---

## 6. Visual Evidence (Screenshots)

Screenshots captured before and after the Design 2.0 transformation at desktop (1440×900) and mobile (375×812):

- **Before Transformation**:
  - `docs/milestones/design2-prototype/before/today-desktop.png`
  - `docs/milestones/design2-prototype/before/today-mobile-375.png`
- **After Transformation**:
  - `docs/milestones/design2-prototype/after/today-desktop.png`
  - `docs/milestones/design2-prototype/after/today-mobile-375.png`
