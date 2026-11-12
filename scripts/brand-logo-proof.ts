/**
 * Proof that the shipped mark IS the reference knot (docs/BRAND.md). Run after changing the mark:
 *   pnpm exec tsx scripts/brand-logo-proof.ts
 *
 * Writes:
 * - docs/design/logo-exact-overlay.png: the shipped mark at 50% opacity over the reference crop, at
 *   the crop's exact size (150 x 116) and the same overlay enlarged 6x.
 * - docs/design/logo-exact-sidebyside.png: the reference crop and the shipped mark at large size,
 *   plus the shipped mark at 32 px and 16 px.
 * - docs/design/logo-exact-trace-1x.png: the shipped mark alone at the crop's exact size, for the
 *   pixel comparison (IoU) reported in docs/BRAND-PASS.md.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  BRAND,
  MARK_PATH,
  MARK_VIEWBOX,
  TRACE_CROP_VIEWBOX,
} from "../src/components/brand/mark-geometry";

const OUT = path.join(process.cwd(), "docs/design");
const [, , CW, CH] = TRACE_CROP_VIEWBOX.split(" ").map(Number) as [number, number, number, number];
const CROP = { x: 40, y: 50, w: CW, h: CH }; // the crop the path was traced in (brand-trace-logo.py)

const sheet = `data:image/png;base64,${readFileSync(
  path.join(OUT, "reference-logo-knot.png"),
).toString("base64")}`;

/** The reference crop as a CSS background, at `scale`. */
function refCrop(scale: number, smooth = true) {
  return `<div style="width:${CROP.w * scale}px;height:${CROP.h * scale}px;background:url(${sheet}) -${CROP.x * scale}px -${CROP.y * scale}px / ${498 * scale}px ${332 * scale}px no-repeat;image-rendering:${smooth ? "auto" : "pixelated"}"></div>`;
}
function traced(scale: number, opacity = 1, viewBox = TRACE_CROP_VIEWBOX, w = CROP.w, h = CROP.h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w * scale}" height="${h * scale}" style="opacity:${opacity};display:block"><path d="${MARK_PATH}" fill="${BRAND.violet}" fill-rule="evenodd"/></svg>`;
}
function overlay(scale: number) {
  return `<div style="position:relative;width:${CROP.w * scale}px;height:${CROP.h * scale}px">${refCrop(scale)}<div style="position:absolute;inset:0">${traced(scale, 0.5)}</div></div>`;
}
const label = (t: string) =>
  `<div style="font:12px system-ui;color:#555;margin-top:6px">${t}</div>`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setViewportSize({ width: CROP.w, height: CROP.h });
  await page.setContent(`<body style="margin:0;background:#fff">${traced(1)}</body>`);
  await page.screenshot({ path: path.join(OUT, "logo-exact-trace-1x.png") });

  await page.setViewportSize({ width: 1180, height: 780 });
  await page.setContent(
    `<body style="margin:0;padding:24px;background:#fff;display:flex;gap:40px;align-items:flex-start">
      <div>${overlay(1)}${label("exact crop size, 150 x 116")}</div>
      <div>${overlay(6)}${label("same overlay at 6x: shipped mark at 50% over the reference")}</div>
    </body>`,
  );
  await page.screenshot({ path: path.join(OUT, "logo-exact-overlay.png"), fullPage: true });

  const [, , mw, mh] = MARK_VIEWBOX.split(" ").map(Number) as [number, number, number, number];
  const small = (px: number) => traced(1, 1, MARK_VIEWBOX, (px * mw) / mh, px);
  await page.setViewportSize({ width: 1180, height: 560 });
  await page.setContent(
    `<body style="margin:0;padding:24px;background:#fff;display:flex;gap:40px;align-items:flex-end">
      <div>${refCrop(3.5)}${label("reference crop (3.5x)")}</div>
      <div>${traced(3.5)}${label("shipped mark (3.5x)")}</div>
      <div>${small(32)}${label("32 px")}</div>
      <div>${small(16)}${label("16 px")}</div>
    </body>`,
  );
  await page.screenshot({ path: path.join(OUT, "logo-exact-sidebyside.png"), fullPage: true });
  await browser.close();
}

void main();
