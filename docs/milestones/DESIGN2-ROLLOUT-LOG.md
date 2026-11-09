# DESIGN 2.0 ROLLOUT — Session 1: Accounts, Health, Account 360

**Milestone**: Design 2.0 Rollout — Session 1 (Accounts, Health, Account 360)  
**Target Class**: Modern premium SaaS (Linear / Attio / Vitally class)  
**Date**: November 6, 2026  
**Status**: COMPLETE  

---

## 1. Overview & Objectives

Following the approved shell + Today Design 2.0 prototype ([`DESIGN2-PROTOTYPE-LOG.md`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/DESIGN2-PROTOTYPE-LOG.md)), Session 1 rolls out the design system to the core account and health surfaces:
1. **R1 — Accounts**: Premium data grid with compact rows, account monogram + domain stacking, health score + StatusPill, segmented CSM Pulse controls, inline editing styled as data, sticky table header, row hover Open action, single-card filter bar, and styled pagination footer.
2. **R2 — Health**: KPI band cards matching Today's pattern, band distribution bar from live counts, 30-day portfolio trend chart loaded strictly from existing `portfolioHealthTrend` computation and live snapshots (zero invented metrics or history), and restyled mover lists.
3. **R3 — Account 360**: Premium header with monogram avatar, stacked name/domain, status pills, circular SVG health score ring + band pill, restyled tab navigation, and shared card patterns for Overview and Health tabs.

### Core Principles
- **Layout changes permitted**: Modern premium table layout, card-based surfaces, circular score visualization, and unified filter bar.
- **Behaviour, data, and copy meaning strictly preserved**: Zero invented metrics, deltas, or sparklines. Inline editing keeps working identically.
- **Strict Accessibility & Test IDs**: Preserved every `data-testid`, ARIA label, accessible name, form field name, route, and permission check.
- **Zero Stopped Specs**: All targeted e2e specs and a11y suites pass cleanly without modifying test assertions.

---

## 2. Implementation Summary

### R1 — Accounts Data Grid (`src/app/(app)/accounts/page.tsx`)
- **Single-Card Filter Bar**:
  - Filter controls consolidated into a single elevated `DataListCard` surface (`surface-card`).
  - Search input styled with search icon prefix and clean border/focus states.
  - Dropdown selects for Tier, Stage, Owner, and Sort restyled to align with the design system.
  - Retains all query param bindings, auto-submit behavior, and "Clear filters" link.
- **Compact Table & Row Pattern**:
  - `sticky top-0 bg-background/95 backdrop-blur z-10` header with tight tracking and uppercase column labels.
  - Monogram avatar (`DataListAvatar`) paired with stacked account name and domain (`text-muted-foreground text-xs`).
  - Health column displays the numerical health score alongside a semantic `StatusPill` with status indicator dot.
  - Row hover state displays a subtle `surface-interactive` background with an `Open` action link navigating to `/accounts/[id]`.
- **Inline Editing Styled as Data (`src/components/app/inline-field.tsx`)**:
  - Form selects (Tier, Stage, Owner) and the renewal-date input restyled to look like plain data in resting state (borderless, transparent background).
  - Hover and focus states display border, subtle background, and custom Lucide `ChevronDown` icon.
  - Preserves exact form action endpoints, hidden fields (`accountId`, `returnTo`), automatic `onChange` submission, and test IDs (`data-testid="stage-select"`, `data-testid="owner-select"`, `data-testid="renewal-input"`).
- **CSM Pulse Segmented Control (`src/components/app/pulse-controls.tsx`)**:
  - Restyled into a compact segmented control with muted track and pill-shaped toggle buttons.
  - Preserves both button triggers ("Actually fine", "Worried"), form submissions, and active state indicators.
- **Styled Pagination Footer**:
  - Displays current row range and total account count (`Showing X–Y of Z accounts`).
  - Restyled Previous / Next pagination buttons preserving URL query parameters.

### R2 — Health Portfolio Overview (`src/app/(app)/health/page.tsx`)
- **KPI Band Cards**:
  - 4 band cards (Healthy, Watch, At Risk, Insufficient Data) adopt the Today KPI card pattern (`surface-interactive`, layered border, soft shadow).
  - Active band filter highlights the selected card with an accent ring.
  - Count, label, and ARR formatted with `formatArr` strictly preserved.
- **Band Distribution Bar**:
  - Added a visual distribution bar directly beneath the band cards showing the proportion of accounts in each band.
  - Uses exact percentages computed from `overview.bands.HEALTHY.count`, `overview.bands.WATCH.count`, and `overview.bands.AT_RISK.count`.
  - Color-coded segments match semantic band tokens (`bg-emerald-500`, `bg-amber-500`, `bg-rose-500`, `bg-zinc-400`).
- **Portfolio Health Trend Chart**:
  - Displays weekly points over a 4-week window ending today.
  - Data loaded strictly from `portfolioHealthTrend` in `src/modules/reports/service.ts` using real `HealthScoreSnapshot` records (no invented history or synthetic points).
  - Interactive SVG stacked bar chart visualizing weekly counts in Healthy, Watch, and At Risk bands.
- **Restyled Mover & Disagreement Lists**:
  - Biggest Improvers, Biggest Drops, and CSM Disagreements sections wrapped in shared `DataListCard` components.
  - Score changes display directional delta chips (`+X` in emerald, `-X` in rose).
  - Preserved all empty states, headings, accessible names, and links.

### R3 — Account 360 (`src/app/(app)/accounts/[id]/`)
- **Premium Header (`src/app/(app)/accounts/[id]/layout.tsx`)**:
  - Monogram avatar (`DataListAvatar`) generated deterministically from account name initials.
  - Stacked account name heading and external domain link with `ExternalLink` icon.
  - Status pill metadata row: Tier, Lifecycle Stage, CSM Owner, and Commercial Plan.
  - **Health Scorecard Widget**: Circular SVG progress ring (0–100 scale) colored by health band, large score typography, semantic `RiskBadge`, and `DisagreementMark` if CSM pulse disagrees with the model.
- **Restyled Tab Navigation (`src/app/(app)/accounts/[id]/tab-nav.tsx`)**:
  - Clean horizontal tab bar with active indicator underline, hover highlights, and preserved `aria-current="page"`.
  - Accessible names and route URLs for all 18 sub-pages preserved verbatim.
- **Overview Tab (`src/app/(app)/accounts/[id]/page.tsx`)**:
  - **Account Details Card**: Two-column definition list (`dl`) with muted labels, bold values, and inline tier/stage/renewal editing controls.
  - **Key People Card**: Avatar chips, stacked contact names, titles, decision-maker/champion roles, and email links.
  - **Missing Information Card (`src/components/app/missing-data-card.tsx`)**: Restyled with warning surface and icon badge while preserving `aria-label="Missing information"`.
- **Health Tab (`src/app/(app)/accounts/[id]/health/page.tsx`)**:
  - Restyled Health Scorecard, CSM Pulse section, Health Analyst narrative quote card, 6 pillar collapsible details cards, and health score history table into shared card patterns.

---

## 3. Real Data Sources & Integrity Verification

Per user instruction: *"Every number shown must come from existing queries/code — never invent a metric, delta or sparkline; if a trend has no data source, show the stat without a trend and log it."*

| Screen & Element | Data Source | Calculation / Origin | Verification Status |
|---|---|---|---|
| **Health Band Cards** | `overview.bands[b].count`, `overview.bands[b].arrMinor` | Loaded from `healthOverview(ctx)` | Real data; preserves revenue masking when restricted. |
| **Health Band Distribution Bar** | `overview.bands[b].count / totalScoredAccounts` | Derived strictly from live counts | Real data; zero invented counts. |
| **Portfolio Health Trend Chart** | `portfolioHealthTrend({ periodStart, periodEnd, ... })` | Loaded from `HealthScoreSnapshot` records via `liveSnapshotWhere` | Real weekly snapshots from PostgreSQL database; zero mock data. |
| **Accounts Table Health Score** | `account.currentHealth.score` | Active snapshot under current `HealthModel` | Real score; null displayed as "—". |
| **Account 360 SVG Score Ring** | `health.score` | Active snapshot score (0–100) rendered as `strokeDashoffset` | Real score; presentation only. |

---

## 4. Test & Verification Results

### Targeted E2E Specs

| Spec | Target Surface | AI Recorded Mode | AI-Off Mode | Status |
|---|---|---|---|---|
| `e2e/m2-account360.spec.ts` | Account 360 tabs, inline edit, key people, notes | **PASSED** (10/10) | **PASSED** (10/10) | ✅ Green |
| `e2e/m3-health-signals.spec.ts` | Health overview, filters, movers, overrides, recompute | **PASSED** (9/9) | **PASSED** (9/9) | ✅ Green |
| `e2e/a11y.spec.ts` | Global axe-core accessibility suite (desktop + mobile) | **PASSED** (8/8) | **PASSED** (8/8) | ✅ Green |
| `e2e/a11y-m3.spec.ts` | Health screen axe-core WCAG 2.1 AA audit | **PASSED** (2/2) | **PASSED** (2/2) | ✅ Green |

### Typecheck, Linter & Production Build

| Check | Command | Exit Code | Result |
|---|---|---|---|
| **TypeScript Compiler** | `pnpm typecheck` | `0` | Clean; 0 errors (`next typegen && tsc --noEmit`). |
| **ESLint & Secret Check** | `pnpm lint` | `0` | Clean; 0 warnings, 0 errors, 1612 files scanned. |
| **Next.js Production Build** | `pnpm build` | `0` | Compiled successfully in 4.9s; static pages generated; all routes valid. |

---

## 5. Before & After Screenshot Inventory

All screenshots captured against the production build with seeded demo data (`dana@larkspur.test` as CSM Leader).

| Screen | Viewport | Before Screenshot | After Screenshot |
|---|---|---|---|
| **Accounts** | Desktop (1440×900) | [`before/accounts-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/accounts-desktop.png) | [`after/accounts-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/accounts-desktop.png) |
| **Accounts** | Mobile (375×812) | [`before/accounts-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/accounts-mobile-375.png) | [`after/accounts-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/accounts-mobile-375.png) |
| **Health** | Desktop (1440×900) | [`before/health-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/health-desktop.png) | [`after/health-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/health-desktop.png) |
| **Health** | Mobile (375×812) | [`before/health-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/health-mobile-375.png) | [`after/health-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/health-mobile-375.png) |
| **Account 360** | Desktop (1440×900) | [`before/account360-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/account360-desktop.png) | [`after/account360-desktop.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/account360-desktop.png) |
| **Account 360** | Mobile (375×812) | [`before/account360-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/before/account360-mobile-375.png) | [`after/account360-mobile-375.png`](file:///Users/sahil/customer%20suesss%20platform/docs/milestones/design2-rollout/after/account360-mobile-375.png) |

---

## 6. Stopped Specs & Discrepancies

**None.**  
Every spec in `e2e/m2-account360.spec.ts` and `e2e/m3-health-signals.spec.ts` ran to completion and passed on the first attempt without modifying existing test files. All accessibility audits passed with zero WCAG 2.1 AA violations.
