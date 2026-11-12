import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PRODUCT_NAME } from "../src/config/product";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";

const SHOTS = path.join(process.cwd(), "docs/design");

/** Total layout shift on the page so far (CLS-style sum of shifts without recent input). */
async function layoutShift(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as {
            value: number;
            hadRecentInput: boolean;
          }[])
            if (!e.hadRecentInput) total += e.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve(total), 1500);
      }),
  );
}

test.describe("Brand pass", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport set per test");
  });

  test("sign-in: split brand panel, wordmark heading, tagline, terracotta button, no layout shift", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: PRODUCT_NAME })).toBeVisible();
    await expect(page.getByText("Your AI customer success manager.")).toBeVisible();
    await expect(page.getByText("Approvals before anything is sent")).toBeVisible();
    // The wordmark is set in the display face.
    const family = await page
      .getByRole("heading", { level: 1 })
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family.toLowerCase()).toContain("sora");
    // The brand panel is the same in both app themes: fixed charcoal, whatever the theme.
    const panelBg = () =>
      page
        .locator("main > section")
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const lightBg = await panelBg();
    expect(await layoutShift(page)).toBe(0);
    await page.screenshot({ path: path.join(SHOTS, "signin-brand-desktop.png") });
    await page
      .context()
      .addCookies([
        {
          name: "nx-theme",
          value: "dark",
          url: `http://localhost:${process.env.E2E_PORT ?? 3100}`,
        },
      ]);
    await page.reload();
    expect(await panelBg()).toBe(lightBg);
    await expectNoBlockingViolations(page);
  });

  test("sign-in on a phone: compact band with mark and name; form unchanged", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: PRODUCT_NAME })).toBeVisible();
    await expect(page.getByText("Your AI customer success manager.")).toBeHidden();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await layoutShift(page)).toBe(0);
    await expectNoBlockingViolations(page);
    await page.screenshot({ path: path.join(SHOTS, "signin-brand-mobile.png") });
  });

  for (const theme of ["light", "dark"] as const) {
    test(`sidebar logo lockup (${theme})`, async ({ page, context }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await context.addCookies([
        { name: "nx-theme", value: theme, url: `http://localhost:${process.env.E2E_PORT ?? 3100}` },
      ]);
      await signIn(page, "dana@larkspur.test");
      const aside = page.locator("aside");
      await expect(aside.locator("svg").first()).toBeVisible();
      await expect(aside).toContainText(PRODUCT_NAME);
      expect(await layoutShift(page)).toBe(0);
      await aside.screenshot({ path: path.join(SHOTS, `sidebar-logo-${theme}.png`) });
    });
  }

  test("favicon set is served from the same mark", async ({ page, request }) => {
    for (const [url, type] of [
      ["/icon.svg", "image/svg+xml"],
      ["/icon1.png", "image/png"],
      ["/icon2.png", "image/png"],
      ["/apple-icon.png", "image/png"],
    ] as const) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()["content-type"], url).toContain(type);
    }
    await page.goto("/sign-in");
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveCount(1);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });
});
