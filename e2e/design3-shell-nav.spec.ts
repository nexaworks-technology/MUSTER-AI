import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";

for (const theme of ["light", "dark"] as const) {
  test(`all 17 nav items and the user card fit at 1280x800 without scrolling (${theme})`, async ({
    page,
    context,
  }, ti) => {
    test.skip(ti.project.name !== "desktop");
    await context.addCookies([{ name: "nx-theme", value: theme, url: "http://localhost:3100" }]);
    await signIn(page, "admin@larkspur.test");
    await page.goto("/today");
    const m = await page
      .locator("aside nav")
      .evaluate((n) => ({ sh: n.scrollHeight, ch: n.clientHeight }));

    expect(m.sh).toBeLessThanOrEqual(m.ch);
    const labels = [
      "Home",
      "Today",
      "Approvals",
      "Tasks",
      "Meetings & QBRs",
      "Accounts",
      "Health",
      "Onboarding",
      "Renewals",
      "Expansion",
      "Revenue",
      "Plays",
      "Inbox",
      "Promises",
      "Reports",
      "Ask AI",
      "Settings",
    ];
    for (const l of labels) {
      const box = await page
        .locator("aside nav")
        .getByRole("link", { name: l, exact: true })
        .boundingBox();
      const user = await page.locator("aside").getByText("Admin", { exact: true }).boundingBox();
      expect(box, l).not.toBeNull();
      expect(box!.y + box!.height, `${l} above user card`).toBeLessThanOrEqual(user!.y);
    }
    await page.screenshot({ path: path.join(process.cwd(), `docs/design/shell-${theme}.png`) });
  });
}
