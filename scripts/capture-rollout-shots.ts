import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../prisma/seed/users";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function contextFor(
  browser: Browser,
  base: string,
  email: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(`${base}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/today$/, { timeout: 60_000 });
  return page;
}

async function captureScreen(page: Page, url: string, outPath: string) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`Saved ${path.basename(outPath)}`);
}

async function main() {
  const target = arg("target") ?? "before";
  const base = arg("base") ?? "http://localhost:3000";
  const outDir = path.join(process.cwd(), "docs", "milestones", "design2-rollout", target);
  mkdirSync(outDir, { recursive: true });

  const accountId = "seed62f09b8595f2ca0595c0b"; // Brightwell Logistics

  const browser = await chromium.launch();

  // Desktop (1440x900)
  const deskPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 1440,
    height: 900,
  });

  await captureScreen(deskPage, `${base}/accounts`, path.join(outDir, "accounts-desktop.png"));
  await captureScreen(deskPage, `${base}/health`, path.join(outDir, "health-desktop.png"));
  await captureScreen(deskPage, `${base}/accounts/${accountId}`, path.join(outDir, "account360-desktop.png"));
  await deskPage.context().close();

  // Mobile (375x812)
  const mobPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 375,
    height: 812,
  });

  await captureScreen(mobPage, `${base}/accounts`, path.join(outDir, "accounts-mobile-375.png"));
  await captureScreen(mobPage, `${base}/health`, path.join(outDir, "health-mobile-375.png"));
  await captureScreen(mobPage, `${base}/accounts/${accountId}`, path.join(outDir, "account360-mobile-375.png"));
  await mobPage.context().close();

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
