# Brand pass: Muster AI logo, sign-in, type (2026-11-12)

References: `docs/design/reference-logo-knot.png` and `docs/design/reference-signin-branded.png`
(both supplied by the founder in chat; neither was in the repo at first, so the work stopped until they
arrived, then they were saved there). The rules are in `docs/BRAND.md`.

**Result: PASS**, with the deviations listed below. **Final violet: `#5B2A7A`** (deep ink violet,
RGB 91, 42, 122, as on the reference sheet).

## What was built

1. **The mark:** a clean vector redrawing of the knot (two interlocking ribbons forming an M, the right
   passing over the left), one geometry module (`src/components/brand/mark-geometry.ts`) feeding the
   `MusterMark` / `MusterLockup` components and the favicon generator. Variants: primary (violet) and
   reversed (warm white); `auto` picks one of the two by theme. A small drawing (no crossing gap,
   heavier ribbons) keeps it legible at 16-32 px.
2. **Favicon set** generated from the same paths (`scripts/brand-icons.ts`): `src/app/icon.svg`,
   `icon1.png` (32), `icon2.png` (512), `apple-icon.png` (180, on warm white). Next serves them and
   adds the `<link rel="icon">` / `apple-touch-icon` tags (tested).
3. **Placement:** sidebar header (lockup replaces the plain-text product name; the workspace row
   stays under it), sign-in, invitation page (both via the split layout), customer portal header.
   The Ask AI byline keeps the terracotta starburst.
4. **Sign-in (split screen):** left brand panel, a fixed look in both themes (warm charcoal with a
   violet and terracotta aurora wash, the reversed mark large, the wordmark as the page `h1`, the
   tagline "Your AI customer success manager." and three quiet lines: proactive signals on every
   account, approvals before anything is sent, answers that cite their sources). Right: the existing
   form on warm paper with a terracotta button and a "Welcome back" heading. On a phone the panel
   collapses to a band with the mark and the name. The invitation page uses the same layout.
   **No auth behaviour changed:** same form, same fields, same action, same Google button.
5. **Type:** Sora (via `next/font`, self-hosted) for the wordmark and every page `h1`; body stays
   Inter. `display: optional` with preload and a metric-matched fallback.

## Deviations from the references

- **The sign-in reference shows controls the product does not have**: "Remember me", "Forgot
  password?", "Sign up", "Need help?", Terms / Privacy links and a password eye toggle. None were
  added: they would be links to nothing (CLAUDE.md Rule 6) or auth behaviour changes, which the brief
  ruled out. The layout, colours and typography follow the reference; the form is the existing one.
- **The reference sign-in uses a different logo (a petal mark) and a serif wordmark.** The brief's
  knot and Sora were used instead, as instructed.
- **The mark is a geometric simplification** of the knot on the reference sheet (one crossing, round
  ends), so it reads at 16 px. Judge `docs/design/favicon-32.png` and the large panel mark.
- **Email:** emails are plain text with no logo slot (`src/lib/email`), so no logo was added there.
- **New copy:** the three panel lines, "Welcome back" and "Sign in to your Muster AI account." are new
  text; the tagline is from the brief.
- **Page headings changed face app-wide:** every `h1` now uses Sora, as the brief asked ("page
  headings"). Not reviewed screen by screen by eye.

## Verification (production build, recorded AI)

- `pnpm typecheck`, `pnpm lint`: pass.
- Vitest `theme-tokens`: **103 passed**, including new brand-panel tests: wordmark and tagline at least
  4.5:1 on the charcoal and on each aurora peak, the reversed mark at least 3:1, the theme mark at least
  3:1 on the page, paper and sidebar, and the panel colours identical in both themes.
- New `e2e/brand-pass.spec.ts` (5 passed): split sign-in with the wordmark as `h1` in Sora, tagline and
  lines, **layout shift 0** on desktop sign-in, phone sign-in and the app shell (light and dark); panel
  identical in dark; axe on sign-in at 1280 and 375; sidebar lockup in both themes; favicon files and
  head tags served.
- Sign-in e2e `m1-foundation` (sign-in, wrong password, invitation, members): passed; AI-off run
  passed. `rename-muster` and the 17-item nav fit check (the new sidebar header still fits at
  1280 x 800): passed.
- **a11y suites (26 tests, includes the new sign-in): light 26/26, dark 26/26.**
- Not run: the full gate and the full e2e suite. The Docker stack was not rebuilt.

## Screenshots (docs/design/)

`signin-brand-desktop.png`, `signin-brand-mobile.png`, `sidebar-logo-light.png`,
`sidebar-logo-dark.png`, `favicon-32.png` (the 32 px icon on white, actual size and 8x).
