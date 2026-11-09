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

async function main() {
  const target = arg("target") ?? "before";
  const base = arg("base") ?? "http://localhost:3000";
  const outDir = path.join(process.cwd(), "docs", "milestones", "design2-prototype", target);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();

  // Desktop (1440x900)
  const deskPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 1440,
    height: 900,
  });
  await deskPage.goto(`${base}/today`, { waitUntil: "networkidle" });
  await deskPage.screenshot({ path: path.join(outDir, "today-desktop.png"), fullPage: true });
  console.log(`Saved ${target}/today-desktop.png`);
  await deskPage.context().close();

  // Mobile (375x812)
  const mobPage = await contextFor(browser, base, "dana@larkspur.test", {
    width: 375,
    height: 812,
  });
  await mobPage.goto(`${base}/today`, { waitUntil: "networkidle" });
  await mobPage.screenshot({ path: path.join(outDir, "today-mobile-375.png"), fullPage: true });
  console.log(`Saved ${target}/today-mobile-375.png`);
  await mobPage.context().close();

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
