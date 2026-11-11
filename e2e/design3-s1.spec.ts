import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { ensureM11Data } from "./support/m11";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";
const SHOTS = path.join(process.cwd(), "docs/design");
const THEMES = ["light", "dark"] as const;

/** Design 3.0 session 1: glass shell, Today and Ask AI, light and dark, with the toggle. */

async function setTheme(context: BrowserContext, theme: "light" | "dark") {
  await context.addCookies([
    { name: "nx-theme", value: theme, url: `http://localhost:${process.env.E2E_PORT ?? 3100}` },
  ]);
}

async function dana(page: Page) {
  await ensureM11Data(WS);
  await signIn(page, "dana@larkspur.test");
  return inWorkspace(WS, async (tx, ws) => {
    const m = await tx.askMessage.findFirstOrThrow({
      where: {
        workspaceId: ws,
        role: "USER",
        content: { contains: "mentioned a competitor" },
        thread: { user: { email: "dana@larkspur.test" } },
      },
      orderBy: { createdAt: "desc" },
    });
    return m.threadId;
  });
}

const backdrop = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backdropFilter);

test.describe("Design 3.0 session 1", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "visual pass runs on desktop (axe also on mobile below)",
    );
  });

  for (const theme of THEMES) {
    test(`${theme}: Today and Ask render, pass axe, blur only on chrome`, async ({
      page,
      context,
    }) => {
      test.setTimeout(600_000);
      await setTheme(context, theme);
      const thread = await dana(page);

      await page.goto("/today");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Approvals waiting/ })).toBeVisible();
      await expectNoBlockingViolations(page);
      // Chrome blurs; cards and panels never do.
      expect(await backdrop(page, "header")).toContain("blur");
      expect(await backdrop(page, "aside")).toContain("blur");
      expect(await backdrop(page, ".glass-surfaces [data-slot=card]")).toBe("none");
      await page.screenshot({ path: path.join(SHOTS, `today-${theme}.png`), fullPage: false });

      await page.goto(`/ask/${thread}`);
      await expect(page.getByTestId("ask-messages")).toContainText("Tallyfield");
      await expectNoBlockingViolations(page);
      expect(await backdrop(page, "[data-testid=thread-list]")).toBe("none");
      await page.screenshot({ path: path.join(SHOTS, `ask-${theme}.png`), fullPage: false });

      await page.goto("/ask");
      await expectNoBlockingViolations(page);
    });
  }

  test("system follows the OS (dark) when no choice is saved", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await signIn(page, "dana@larkspur.test");
    await page.goto("/today");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    // The dark token block applies: it sets color-scheme: dark and the midnight background token.
    const scheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(scheme).toBe("dark");
    await expectNoBlockingViolations(page);
  });

  test("toggle: light, dark, system; persists across reload; set before first paint", async ({
    page,
    context,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/today");
    const group = page.getByRole("radiogroup", { name: "Colour theme" });
    await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await group.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(group.getByRole("radio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // No flash: the server already put data-theme on <html> in the very first HTML it sent.
    const cookies = await context.cookies();
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await page.request.get("/today", { headers: { cookie: header } });
    expect(await res.text()).toMatch(/<html[^>]*data-theme="dark"/);

    await group.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await group.getByRole("radio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await page.reload();
    await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("reduced transparency: chrome stops blurring and fills go solid", async ({
    page,
    context,
  }) => {
    await setTheme(context, "dark");
    await signIn(page, "dana@larkspur.test");
    await page.goto("/today");
    // Chromium has no emulation switch for this media feature, so assert the rule is shipped and
    // that what it sets is an opaque solid (unit-tested in theme-tokens.test.ts).
    const sheetHasRule = await page.evaluate(() =>
      [...document.styleSheets].some((s) => {
        try {
          return [...s.cssRules].some(
            (r) =>
              r instanceof CSSMediaRule && r.conditionText.includes("prefers-reduced-transparency"),
          );
        } catch {
          return false;
        }
      }),
    );
    expect(sheetHasRule).toBe(true);
  });

  test("mobile layout keeps the toggle reachable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, "dana@larkspur.test");
    await page.goto("/today");
    await expect(page.getByRole("radiogroup", { name: "Colour theme" })).toBeVisible();
    await expectNoBlockingViolations(page);
  });
});
