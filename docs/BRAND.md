# Muster AI brand

Muster AI is the product; NexaWorks is the company. The product name is `PRODUCT_NAME` in
`src/config/product.ts`. This page is the rulebook; the drawing itself lives in code.

## The mark

The founder's original knot, **traced** from the reference sheet
(`docs/design/reference-logo-knot.png`), not redrawn: two interlocking ribbons forming an M, tilted,
with a large loop top-left, a smaller loop top-right, a loop bottom-left and a large oval loop
bottom-right; the same over-under weave and white gaps at every crossing; and the small diamond inside
the right-hand loop.

- **Geometry (single source):** `src/components/brand/mark-geometry.ts`: one filled path (the
  silhouette and its holes, even-odd rule) in the pixel coordinates of the reference crop, plus the
  tight `MARK_VIEWBOX`, the square `ICON_VIEWBOX` and the measured ribbon width.
- **How it was made:** `scripts/brand-trace-logo.py` crops the big mark on the sheet, finds its edge at
  the anti-aliased 45% coverage line (10x upsampled), keeps the real corners sharp, smooths only the
  source's compression noise between them, and fits cubic curves. Pixel overlap with the reference at
  the crop's own size (IoU): 0.988.
- **Proof:** `pnpm exec tsx scripts/brand-logo-proof.ts` writes `docs/design/logo-exact-overlay.png`
  (shipped mark at 50% over the reference, at the crop's exact size and at 6x) and
  `docs/design/logo-exact-sidebyside.png` (reference and mark at large size, plus 32 px and 16 px).
- **Component:** `MusterMark` and the `MusterLockup` (mark + wordmark) in
  `src/components/brand/muster-mark.tsx`. The same geometry at every size: there is no separate
  small drawing.
- **Favicons:** generated from the same geometry by `pnpm exec tsx scripts/brand-icons.ts`:
  `src/app/icon.svg` (any size), `icon1.png` (32), `icon2.png` (512), `apple-icon.png` (180, on warm
  white). Never edit the icon files by hand; change the geometry and regenerate.
- **Source limit:** the reference mark is about 130 x 97 px. If a vector original exists, re-trace
  from it with the same script; edges at very large sizes are only as precise as that source.

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

- **Clearspace:** at least one ribbon width (15.7 of the mark's 96.8-unit height, about 16% of the mark
  height) on every side, free of other text or graphics.
- **Minimum size:** 16 px tall for the mark alone (the weave closes up below about 24 px; prefer 24 px or more); 14 px cap
  height for the lockup's wordmark.

## Do not

- Do not put a gradient, shadow, glow or texture on the mark.
- Do not rotate, skew, stretch or re-proportion it.
- Do not recolour it outside the two variants (no terracotta mark, no grey mark).
- Do not redraw, simplify or regularise the knot, change the over-under weave, remove the diamond, or add outlines.
- Do not place the primary (violet) mark on dark surfaces or the reversed mark on light ones.
