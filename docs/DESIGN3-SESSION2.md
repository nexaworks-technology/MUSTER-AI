# Design 3.0, Sessions 1.5 and 2: three founder fixes, then rollout to every screen (2026-11-11)

Visual changes only: no data, copy or layout-structure change. Session 1 (`7328a8d`) was already on
origin/main before this session started (step 0 confirmed: local HEAD and origin/main both `7328a8d`).

| Phase | Result |
|---|---|
| 1. The three fixes (floating sidebar and top bar, translucent light cards with stronger shadows, richer light ambient) | **PASS** |
| 2. Rollout to all screens | **PASS**, with one full-suite e2e failure that is pre-existing (below) |

## Phase 1: the three fixes

1. **Floating glass sidebar and top bar (both themes).** The sidebar is a rounded (`rounded-2xl`)
   panel with a margin around it, a hairline border, the deep glass shadow and its live backdrop blur,
   sticky and sized to the viewport minus the margin. The top bar follows the same treatment (rounded,
   inset, same shadow); judged consistent in the screenshots, so both float.
2. **Light glass cards.** Light panel fill 0.84 to 0.58 alpha (elevation 2: 0.72, modal/popover: 0.94),
   chrome fill 0.5, stronger violet-tinted shadow stacks (three levels), a stronger hairline and a
   brighter top highlight. Tables and dense grids sit on a separate near-solid `--glass-data` fill
   (0.94 light, 0.92 dark), and sticky table headers are fully opaque.
3. **Richer light ambient.** Base and four blobs (violet, sky, peach, rose) with more chroma and
   larger coverage; still a calm backdrop. Dark gets a matching fourth stop (`--ambient-d`); dark was
   otherwise left as approved.

**Gate (all met before Phase 2 was switched on):** the contrast test (68 tests, now including
`--ambient-d`, the data fill and the opaque sticky header) passed with the new translucent fills with
no text or border adjustment needed; a11y suites 26/26 in light and 26/26 in dark; Today and Ask
re-shot in both themes. At that point the glass scope was still limited to Today and Ask.

## Phase 2: rollout

- `.glass-scope` became `.glass-surfaces` and sits on `<body>`: the card, muted, hover, border, radius
  and shadow tokens are re-mapped for the whole app (Home, Approvals, Tasks, Meetings, Accounts,
  Account 360, Health, Onboarding, Renewals, Expansion, Revenue, Plays, Inbox, Promises, Reports,
  Settings, the customer portal and survey pages). The floating sidebar and ambient background are
  in the shared shell, so they are on every signed-in screen.
- Card shadows use `--shadow-card`; small controls (buttons, kbd) keep the light `xs` shadow.
- **Hard-coded colour hunt.** Searched `src/` for Tailwind palette colours (`sky-`, `indigo-`, `white`,
  `black`, ...), hex, rgb, hsl and oklch literals. Only two places: the avatar-initial chips
  (fixed in Session 1) and the Today renewals tile icon (`text-sky-600`, now `dark:text-sky-400`).
  The line chart, sparkline strokes, health rings and badges already use tokens
  (`var(--primary)`, `var(--border)`, risk tokens) and so follow the theme.
- The Accounts table header carried its own live blur and a 95% card fill; both removed (data rule:
  no blur over data, opaque sticky header).

## Verification (production build, recorded AI, this machine)

- `pnpm typecheck`, `pnpm lint` (ESLint and secret scan, 1,674 files): pass.
- Vitest `theme`: 75 tests passed.
- `e2e/design3-s2.spec.ts` (new): 17 main screens in light and in dark each load, show the floating
  rounded blurred sidebar, have **no live blur anywhere in the content area**, and pass axe: 2 passed.
- `e2e/design3-s1.spec.ts`: 6 passed (selector updated for the renamed class).
- All a11y suites (26 tests, desktop and mobile) in light: 26 passed; with the OS in dark: 26 passed
  (both re-run after the rollout).
- **Full `pnpm test:e2e`, light: main run 121 passed, 1 failed, 96 skipped (mobile, desktop-only by
  design); AI-off run 17 passed.** The one failure is
  `fix-today-health.spec.ts:20` (Today and Renewals row counts, 4 vs 5). **It is not caused by this
  work:** it passes alone and fails in a longer run, and the same failure reproduces on commit
  `7328a8d` (Session 1) with the spec order a11y, ai-cost-pilot, fix-today-health, before any
  Session 2 change. It looks like an ordering dependency on shared e2e data from earlier specs and
  deserves its own look. Not fixed here.
- Not run: the full `pnpm gate` (build is exercised by the e2e builds) and a dark full-suite e2e run
  beyond the a11y suites and the new smoke specs.

## Performance (Accounts grid, 50 rows, 240 scroll frames, headless Chromium)

Chrome blur on vs forced off, run twice per theme: 16.6 ms average frame time on and off in every
run (60 Hz cap), p95 17.5 to 18.5 ms. One cold first run, light, blur on, read 20.1 ms average and
31 ms p95; the repeat was 16.6 ms, so I count it as warm-up, not a cost. Caveat: software-rendered
headless Chromium on one machine; a low-end laptop or phone was not tested. Content never blurs
(asserted on every screen); only the sidebar and top bar do.

## Things to know

- At 1280 x 800 the floating sidebar's navigation scrolls inside the panel: Ask AI sits partly behind
  the user card and Settings is below the fold, until you scroll the nav. Taller windows show all.
  Tightening the nav spacing would fix it (no structure change); not done without your call.
- Today's screenshots show the empty state (nothing queued on the real calendar day).
- The theme is still per browser (cookie), not per user (Session 1 deviation, unchanged).
- Dark mode on the screens beyond Today and Ask was checked with axe and the four screenshots below,
  not by eye on every screen.

## Screenshots (docs/design/, 1280 x 800)

Phase 1 re-shoots: `today-light.png`, `today-dark.png`, `ask-light.png`, `ask-dark.png`.
Phase 2: `accounts-light.png`, `accounts-dark.png`, `health-light.png`, `health-dark.png`,
`account360-light.png`, `account360-dark.png`, `approvals-light.png`, `approvals-dark.png`.

## Addendum: sidebar nav density (micro-fix)

At 1280 x 800 the floating sidebar's navigation scrolled inside the panel. In the sidebar only, at
desktop width (the phone's horizontal nav is untouched): nav item vertical padding `py-1.5` to
`py-1`, no gap between items in a group, group gap `gap-3` to `gap-2`, section label padding and the
nav's outer padding reduced, and the workspace header slightly shorter. No item removed, no order
change, no other screen touched; item height stays at least 24 px.

- Measured: the nav no longer scrolls (scroll height equals client height, 664 px) and all 17 items
  plus Settings sit above the user card in both themes, with roughly 80 px to spare.
- New test `e2e/design3-shell-nav.spec.ts` (light and dark): asserts no internal scroll and that each of
  the 17 items ends above the user card.
- a11y suites: light 26/26, dark 26/26 (the light run also included the new nav spec, 28 in all).
- Screenshots: `docs/design/shell-light.png`, `docs/design/shell-dark.png`.
