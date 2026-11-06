import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, clock, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getRevenueView } from "../read.service";

/** M12 B3: the Revenue page reads a fixed number of times (2 vs 5 accounts in the book). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Revenue page does not grow with rows", () => {
  it("same statements for a 2-account book as for a 5-account book", async () => {
    await w.db.membership.updateMany({
      where: { id: { in: [w.small.membershipId, w.big.membershipId] } },
      data: { canViewRevenue: true },
    });
    const { two, five } = await twoVsFive(w, countQueries, (actor) =>
      getRevenueView({ ...actor, canViewRevenue: true }, {}, clock),
    );
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(14);
  });
});
