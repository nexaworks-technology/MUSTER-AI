import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getAccountExpansion } from "../service";
import { listOpportunities } from "../read.service";

/** M12 B3: Expansion list and the account Expansion tab read a fixed number of times (no N+1). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Expansion queries do not grow with rows", () => {
  it("Expansion list: same statements for 2 accounts as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) =>
      listOpportunities(actor, { status: "ALL" }),
    );
    expect(five.result.rows.length).toBeGreaterThanOrEqual(two.result.rows.length);
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(8);
  });

  it("account Expansion tab: bounded statements", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      getAccountExpansion(actor, ids[0]!),
    );
    // Per-kind evidence reads depend on which accounts have signals; never per row.
    expectBounded(two.queries, five.queries, 5);
    expect(five.queries).toBeLessThanOrEqual(18);
  });
});
