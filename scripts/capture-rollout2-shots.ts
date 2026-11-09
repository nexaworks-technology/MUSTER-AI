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
  const outDir = path.join(process.cwd(), "docs", "milestones", "design2-rollout2", target);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();

  // Desktop (1440x900)
  const deskPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 1440,
    height: 900,
  });

  // Slice 1: Work (Approvals)
  await captureScreen(deskPage, `${base}/approvals`, path.join(outDir, "approvals-desktop.png"));
  // Slice 2: Portfolio (Renewals)
  await captureScreen(deskPage, `${base}/renewals`, path.join(outDir, "renewals-desktop.png"));
  // Slice 3: Automation & Insight (Ask AI)
  await captureScreen(deskPage, `${base}/ask`, path.join(outDir, "ask-desktop.png"));
  // Slice 4: Settings (Workspace)
  await captureScreen(deskPage, `${base}/settings/workspace`, path.join(outDir, "settings-desktop.png"));
  await deskPage.context().close();

  // Desktop unauthenticated / customer-facing
  const deskPublic = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await captureScreen(deskPublic, `${base}/sign-in`, path.join(outDir, "signin-desktop.png"));
  await captureScreen(deskPublic, `${base}/s/token-brightwell-ben-nps`, path.join(outDir, "survey-desktop.png"));
  await deskPublic.context().close();

  // Mobile (375x812)
  const mobPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 375,
    height: 812,
  });

  // Slice 1: Work (Approvals)
  await captureScreen(mobPage, `${base}/approvals`, path.join(outDir, "approvals-mobile-375.png"));
  // Slice 2: Portfolio (Renewals)
  await captureScreen(mobPage, `${base}/renewals`, path.join(outDir, "renewals-mobile-375.png"));
  // Slice 3: Automation & Insight (Ask AI)
  await captureScreen(mobPage, `${base}/ask`, path.join(outDir, "ask-mobile-375.png"));
  // Slice 4: Settings (Workspace)
  await captureScreen(mobPage, `${base}/settings/workspace`, path.join(outDir, "settings-mobile-375.png"));
  await mobPage.context().close();

  // Mobile unauthenticated / customer-facing
  const mobPublic = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
  await captureScreen(mobPublic, `${base}/sign-in`, path.join(outDir, "signin-mobile-375.png"));
  await captureScreen(mobPublic, `${base}/s/token-brightwell-ben-nps`, path.join(outDir, "survey-mobile-375.png"));
  await mobPublic.context().close();

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
