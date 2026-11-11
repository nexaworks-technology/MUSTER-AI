import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";

const SHOTS = path.join(process.cwd(), "docs/design");
const THEMES = ["light", "dark"] as const;

/** Design 3.0 session 2: glass on every screen, light and dark. */
const SCREENS: { name: string; url: string; shot?: string }[] = [
  { name: "Home", url: "/" },
  { name: "Today", url: "/today" },
  { name: "Approvals", url: "/approvals", shot: "approvals" },
  { name: "Tasks", url: "/tasks" },
  { name: "Meetings", url: "/meetings" },
  { name: "Accounts", url: "/accounts", shot: "accounts" },
  { name: "Account 360", url: `/accounts/${seedId("account:brightwell")}`, shot: "account360" },
  { name: "Health", url: "/health", shot: "health" },
  { name: "Onboarding", url: "/onboarding" },
  { name: "Renewals", url: "/renewals" },
  { name: "Expansion", url: "/expansion" },
  { name: "Revenue", url: "/revenue" },
  { name: "Plays", url: "/plays" },
  { name: "Inbox", url: "/inbox" },
  { name: "Promises", url: "/promises" },
  { name: "Reports", url: "/reports" },
  { name: "Settings", url: "/settings/workspace" },
];

async function setTheme(context: BrowserContext, theme: "light" | "dark") {
  await context.addCookies([
    { name: "nx-theme", value: theme, url: `http://localhost:${process.env.E2E_PORT ?? 3100}` },
  ]);
}

test.describe("Design 3.0 session 2", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "visual pass runs on desktop");
  });

  for (const theme of THEMES) {
    test(`${theme}: every main screen renders under the glass system and passes axe`, async ({
      page,
      context,
    }) => {
      test.setTimeout(600_000);
      await setTheme(context, theme);
      await signIn(page, "admin@larkspur.test");
      for (const s of SCREENS) {
        const res = await page.goto(s.url);
        expect(res?.status(), s.name).toBeLessThan(400);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("main#main"), s.name).toBeVisible();
        // The floating chrome and the ambient layer are on every screen.
        const chrome = await page
          .locator("aside")
          .first()
          .evaluate((el) => {
            const cs = getComputedStyle(el);
            return { blur: cs.backdropFilter, radius: cs.borderTopLeftRadius };
          });
        expect(chrome.blur, `${s.name} sidebar blur`).toContain("blur");
        expect(parseFloat(chrome.radius), `${s.name} sidebar radius`).toBeGreaterThan(8);
        // Panels and tables never blur; table text sits on a near-solid fill.
        const blurred = await page.evaluate(() =>
          [...document.querySelectorAll("main *")]
            .filter((el) => {
              const cs = getComputedStyle(el);
              return cs.backdropFilter !== "none" && cs.backdropFilter !== "";
            })
            .map((el) => el.tagName + "." + String(el.className).slice(0, 40)),
        );
        expect(blurred, `${s.name}: live blur inside content`).toEqual([]);
        await expectNoBlockingViolations(page);
        if (s.shot) await page.screenshot({ path: path.join(SHOTS, `${s.shot}-${theme}.png`) });
      }
    });
  }
});
