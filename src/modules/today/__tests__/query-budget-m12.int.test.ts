import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, clock, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getToday, SECTIONS } from "../service";

/**
 * M12 B3: Today reads a fixed number of times whatever the number of items (no N+1). The cost is
 * one freshness read, a page and a count per section, and one account-name read per section that
 * has rows: it depends on the number of sections (5), never on the number of items.
 */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Today does not grow with rows", () => {
  it("statements = 1 + 2 per section + 1 per non-empty section, for a 2-account and a 5-account book", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) => getToday(actor, { clock }));
    const items = (r: Awaited<ReturnType<typeof getToday>>) =>
      r.reduce((a, s) => a + s.items.length, 0);
    const expected = (r: Awaited<ReturnType<typeof getToday>>) =>
      1 + 2 * SECTIONS.length + r.filter((s) => s.items.length > 0).length;
    expect(items(five.result)).toBeGreaterThan(items(two.result));
    expect(two.queries).toBe(expected(two.result));
    expect(five.queries).toBe(expected(five.result));
    expect(five.queries).toBeLessThanOrEqual(1 + 3 * SECTIONS.length);
  });
});
