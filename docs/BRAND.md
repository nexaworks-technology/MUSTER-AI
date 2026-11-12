# Muster AI brand

Muster AI is the product; NexaWorks is the company. The product name is `PRODUCT_NAME` in
`src/config/product.ts`. This page is the rulebook; the drawing itself lives in code.

## The mark

Two interlocking ribbons forming an M: each rises as an outer leg, turns over a rounded lobe and
falls diagonally across the middle; the right ribbon passes over the left at the crossing.
It is a clean geometric redrawing of the knot on the founder's reference sheet
(`docs/design/reference-logo-knot.png`), simplified so it stays legible at 16 px.

- **Geometry (single source):** `src/components/brand/mark-geometry.ts` (paths, ribbon width,
  crossing gap, viewBox 64 x 48).
- **Component:** `MusterMark` and the `MusterLockup` (mark + wordmark) in
  `src/components/brand/muster-mark.tsx`.
- **Small drawing (16-32 px):** the same paths with no crossing gap and slightly heavier ribbons
  (`small`), used for the favicon and the sidebar lockup.
- **Favicons:** generated from the same geometry by `pnpm exec tsx scripts/brand-icons.ts`:
  `src/app/icon.svg` (any size), `icon1.png` (32), `icon2.png` (512), `apple-icon.png` (180, on warm
  white). Never edit the icon files by hand; change the geometry and regenerate.

## Variants (the only two colours the mark may take)

| Variant | Colour | Use |
|---|---|---|
| Primary | Deep ink violet `#5B2A7A` | Light surfaces |
| Reversed | Warm white `#F6EFE6` | Dark surfaces and the brand panel |

In the app the sidebar mark switches between these two by theme (`variant="auto"`).

## Colours

| Name | Hex | Role |
|---|---|---|
| Deep ink violet | `#5B2A7A` | Brand: the mark, the wordmark on light surfaces |
| Terracotta | `#D26B46` (dark theme `#E2805E`) | The AI's accent: the Ask AI starburst, send button. Not the product logo. |
| Terracotta, deep | `#9A4729` | Text-bearing actions on warm paper (sign-in button, "Yes, do it"); white text on it is 4.5:1 or better |
| Warm paper | `#FAF5EE` (dark theme `#1A1511`) | The conversation area and the sign-in form side |
| Warm charcoal | `#1F1A19` | The brand panel (sign-in, invitations), the same in both themes |
| Warm white | `#F6EFE6` | Reversed mark and wordmark on the brand panel |

The source values are oklch tokens in `src/app/globals.css` (`--brand-*`, `--ask-*`); the hex values
above are their sRGB equivalents. Contrast is tested in `src/app/__tests__/theme-tokens.test.ts`.

**Violet is the brand; terracotta is the AI and action accent.** The Ask AI byline keeps its
terracotta starburst: that is the AI's mark, not the product logo.

## Type

- **Display face: Sora** (Google, self-hosted at build time by `next/font`), for the wordmark and
  page headings (`h1`) only. Body text stays Inter.
- **Wordmark:** the product name in Sora, medium weight, upper case, tracking 0.14 em.
- Sora loads with `display: optional` (preloaded, metric-matched fallback): it never swaps after
  first paint, so there is no layout shift (tested: CLS 0 on sign-in and the app shell).

## Clearspace and minimum size

- **Clearspace:** at least one ribbon width (7.5 of the mark's 48-unit height, about 16% of the mark
  height) on every side, free of other text or graphics.
- **Minimum size:** 16 px tall for the mark alone (use the small drawing below 32 px); 14 px cap
  height for the lockup's wordmark.

## Do not

- Do not put a gradient, shadow, glow or texture on the mark.
- Do not rotate, skew, stretch or re-proportion it.
- Do not recolour it outside the two variants (no terracotta mark, no grey mark).
- Do not redraw the ribbons, change the over/under at the crossing, or add outlines.
- Do not place the primary (violet) mark on dark surfaces or the reversed mark on light ones.
