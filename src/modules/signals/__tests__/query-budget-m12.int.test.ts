import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listAccountSignals, listSignals } from "../service";

/**
 * M12 B3: the Signals list and the account Signals tab read a fixed number of times whatever the
 * number of rows (no N+1). A CSM who owns 2 accounts is compared with one who owns 5.
 */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Signals queries do not grow with rows", () => {
  it("Signals list: same statements for 2 accounts as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) =>
      listSignals(actor, {} as never),
    );
    expect(two.result.total).toBeGreaterThan(0);
    expect(five.result.total).toBeGreaterThan(two.result.total);
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(20);
  });

  it("account Signals tab: same statements for 2 live signals as for more", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      listAccountSignals(actor, ids[0]!),
    );
    // Per-kind evidence reads depend on which accounts have signals; never per row.
    expectBounded(two.queries, five.queries, 5);
  });
});
