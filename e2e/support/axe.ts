import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** No serious or critical axe violations (WCAG 2.1 AA tags), as in `a11y.spec.ts`. */
export async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}
