/**
 * Generates the favicon set from the mark's own geometry (src/components/brand/mark-geometry.ts),
 * so the icons can never drift from the logo. Run after changing the mark:
 *   pnpm exec tsx scripts/brand-icons.ts
 * Writes src/app/icon.svg (any size; the 16-32 px drawing), icon1.png (32), icon2.png (512),
 * apple-icon.png (180, on warm white: iOS fills transparency with black), and
 * docs/design/favicon-32.png (the 32 px icon on a plain background, actual size and 8x).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { BRAND, markSvg } from "../src/components/brand/mark-geometry";

const APP = path.join(process.cwd(), "src/app");

async function main() {
  writeFileSync(path.join(APP, "icon.svg"), markSvg(BRAND.violet, { small: true }) + "\n");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function png(
    file: string,
    size: number,
    opts: { small?: boolean; bg?: string; pad?: number },
  ) {
    const pad = opts.pad ?? 0;
    const inner = size - 2 * pad;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:${opts.bg ?? "transparent"};width:${size}px;height:${size}px;display:grid;place-items:center">${markSvg(BRAND.violet, { small: opts.small, size: inner })}</body>`,
    );
    await page.screenshot({ path: file, omitBackground: !opts.bg });
  }
  await png(path.join(APP, "icon1.png"), 32, { small: true });
  await png(path.join(APP, "icon2.png"), 512, {});
  await png(path.join(APP, "apple-icon.png"), 180, { bg: BRAND.warmWhite, pad: 22 });

  // Preview for the founder: the real 32 px file on white, and the same pixels at 8x.
  await page.setViewportSize({ width: 360, height: 300 });
  const icon = `data:image/png;base64,${(await import("node:fs")).readFileSync(path.join(APP, "icon1.png")).toString("base64")}`;
  await page.setContent(
    `<body style="margin:0;background:#fff;font:13px system-ui;color:#333;display:flex;gap:40px;align-items:center;justify-content:center;height:300px">
      <figure style="margin:0;text-align:center"><img src="${icon}" width="32" height="32"><figcaption>32 px</figcaption></figure>
      <figure style="margin:0;text-align:center"><img src="${icon}" width="256" height="256" style="image-rendering:pixelated;border:1px solid #eee"><figcaption>same 32 px file at 8x</figcaption></figure>
    </body>`,
  );
  await page.screenshot({ path: path.join(process.cwd(), "docs/design/favicon-32.png") });
  await browser.close();
}

void main();
