import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getAccountRenewals } from "../service";
import { listRenewals } from "../read.service";

/** M12 B3: Renewals list and the account Renewal tab read a fixed number of times (no N+1). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Renewals queries do not grow with rows", () => {
  it("Renewals list: same statements for 2 accounts as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) =>
      listRenewals(actor, { days: 365 }),
    );
    expect(two.result.rows.length).toBe(2);
    expect(five.result.rows.length).toBe(5);
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(8);
  });

  it("account Renewal tab: bounded statements", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      getAccountRenewals(actor, ids[0]!),
    );
    expectBounded(two.queries, five.queries);
    expect(five.queries).toBeLessThanOrEqual(12);
  });
});
