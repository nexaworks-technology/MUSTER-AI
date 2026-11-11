# Design 3.0, Session 1: glass system, shell, Today and Ask AI (2026-11-11)

**Result: PARTIAL.** Everything asked for is built and verified, except three things that the brief
assumed and the repo did not provide (below). The rollout to the other screens has NOT started and
waits for the founder's verdict on the four screenshots.

| Item | Result |
|---|---|
| 1. Token layer, both themes, contrast-tested | **PASS** |
| 2. Glass rules (blur only on fixed chrome; solid data; reduced transparency / motion) | **PASS** |
| 3. Toggle light / dark / system, default system, no flash | **PASS**, persisted per browser, not per user (see Deviations) |
| 4. Applied to shell, Today, Ask AI | **PASS** |
| 5. Verify: typecheck, lint, a11y both themes, e2e smoke both themes, screenshots, perf | **PASS** (perf: see below) |
| Reference images | **NOT AVAILABLE**: `docs/design/reference-light.png` and `reference-dark.png` are not in the repo |

## Deviations and things to know

1. **The reference images do not exist in the repo** (or in Downloads/Desktop). The look was built
   from the written direction only (frosted panels over an ambient gradient, hairline borders, deep
   soft shadows, violet-to-teal accent, generous radius). Please judge the screenshots against the
   originals; colours and radii are one token edit each.
2. **"Persisted per user" is per browser.** The choice is a cookie (`nx-theme`, one year). Per user
   would need a column on the global `User` table, a migration, and changes to the export allow-list
   and purge (DATA_MAP). Not done: it is a data-model decision, and this session was visual only.
3. **Today's screenshots show the empty state.** The e2e world is the seeded demo on the real
   calendar day (Nov 11), when nothing is queued. The cards, KPI tiles and list panels are all
   visible, but no queue rows or approval cards were on screen. Ask AI's screenshots show a real
   answered thread with a citation chip.
4. **Dark mode reaches every screen, not only the three this session restyles.** The toggle is
   global, so the dark tokens apply everywhere; the other screens keep Design 2.0 *styling* (solid
   cards) but now have a dark palette. The existing a11y suites in dark found one component that
   hard-coded light-only colours (the avatar-initials chips in `data-list.tsx`); fixed with a
   `dark:` variant. Other screens were only checked by axe, not by eye.
5. `.glass-popover` (modals and popovers) is defined and tested but unused: the app has no modal or
   popover component yet.

## What was built

- `src/app/globals.css`: light tokens (`:root`), dark tokens (`:root[data-theme="dark"]` and the
  identical set under `prefers-color-scheme: dark` when no choice is saved), ambient backgrounds
  (light pastel violet/blue/peach; dark midnight with violet/cyan aurora), three panel elevations,
  hairline border, shadow stacks, violet-to-teal accent gradient, radius scale in `.glass-scope`.
  A `dark:` Tailwind variant follows the same two paths.
- Glass rules in CSS: `.glass-chrome` (sidebar, top bar) is the only live blur; cards and panels use
  translucent fills, hairlines and shadows. `.glass-scope` (Today and Ask AI) re-maps `--card`,
  `--muted`, `--hover`, `--border`, radius and shadows to the glass values and switches off the
  sticky-header blur data lists carry. `prefers-reduced-transparency` swaps every glass fill for its
  solid stand-in and removes blur; `prefers-reduced-motion` removes hover lift and transitions; a
  `@supports not (backdrop-filter)` fallback makes chrome solid.
- Theme: `src/lib/theme/` (cookie, parsing), `src/components/app/theme-toggle.tsx` (radiogroup in
  the top bar), root layout sets `data-theme` from the cookie on the server, so the first byte of
  HTML already carries the theme (no inline script, nothing for the CSP).
- Shell: `(app)/layout.tsx` (glass sidebar and top bar over the ambient background), `today/page.tsx`
  and `ask/layout.tsx` gain the `glass-scope` class. **No data, copy or layout structure changed.**

## Tests (written first; the token test was RED before the CSS existed)

- `src/app/__tests__/theme-tokens.test.ts` (64 tests): both dark blocks identical; dark overrides
  every light colour token; WCAG AA for 23 text/background pairs and the accent gradient (4.5:1) and
  focus ring / field boundary (3:1) in **both** themes; panel, table-tint and chrome text over the
  worst ambient backdrop (each peak colour) in both themes; glass hairline visible; blur only in the
  chrome and popover utilities; surface / scope never blur; reduced-transparency, reduced-motion
  and unsupported-browser fallbacks present.
- `src/lib/theme/__tests__/theme.test.ts` (4): default is system; only exact light/dark are kept.
- `e2e/design3-s1.spec.ts` (6, desktop): Today and Ask in light and dark (axe, blur only on chrome,
  `backdrop-filter` computed none on cards and the thread list); system follows an OS in dark; toggle
  light / dark / system persists across reload and the first HTML response already has
  `data-theme="dark"`; the reduced-transparency rule ships; toggle reachable at 375 px.
- `playwright.config.ts`: `E2E_COLOR_SCHEME=dark` runs any suite with the OS in dark.

## Verification run (this machine, production build, recorded AI)

- `pnpm typecheck`, eslint on the touched files: clean (full `pnpm gate` was not run; targeted
  checks only, as for the other post-certification sessions).
- Vitest `theme`: 71 tests passed.
- `e2e/design3-s1.spec.ts`: 6 passed.
- **All existing a11y suites (`e2e/a11y*`, desktop + mobile, 26 tests) in light: 26 passed.**
  **Same suites with the OS in dark (`E2E_COLOR_SCHEME=dark`): first run 11 failed, all
  `color-contrast` from one component (avatar chips, hard-coded light-only colours); fixed; re-run
  26 passed.**
- Not run: the full e2e suite and the full gate.

## Performance (Accounts grid scroll)

Headless Chromium, 50-row Accounts table, 240 frames of scroll, chrome blur on vs forced off:
light 16.6 ms average frame time with blur on and off alike (p95 about 17-18 ms in all four runs).
That is the 60 Hz cap, so **no cost was measurable here**. Caveats: this is software-rendered
headless Chromium on one machine, not a low-end laptop or a phone; the sidebar and top bar are the
only blurred elements and are small, fixed layers. Dark: 16.6 ms average on and off alike (p95 17.0-17.4 ms).

## Screenshots (1280 x 800, Dana, light and dark)

- `docs/design/today-light.png`
- `docs/design/today-dark.png`
- `docs/design/ask-light.png`
- `docs/design/ask-dark.png`

## Not done / next

- Rollout to the remaining screens (waits for the verdict).
- A per-user stored preference (needs a data-model decision).
- A pass of the other screens' dark mode by eye (axe passes; looks not reviewed).
