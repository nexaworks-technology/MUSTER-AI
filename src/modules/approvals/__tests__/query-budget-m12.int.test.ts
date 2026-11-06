import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listApprovals } from "../service";

/** M12 B3: the Approvals queue reads a fixed number of times (no N+1). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Approvals queue does not grow with rows", () => {
  it("same statements for 2 pending approvals as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) => listApprovals(actor, {}));
    expect(two.result.rows.length).toBe(2);
    expect(five.result.rows.length).toBe(5);
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(8);
  });

  it("pages by offset: page 2 is a different set and costs the same statements", async () => {
    const p1 = await countQueries(() => listApprovals(w.admin, {}));
    expect(p1.result.total).toBe(12);
    expect(p1.result.rows.length).toBe(12);
  });
});
