import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** No serious or critical axe violations on every M1 screen, at 1280 px and 375 px (M1 #15). */
const SCREENS = ["/"];

for (const route of SCREENS) {
  test(`axe: ${route}`, async ({ page }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
