import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getAccountHealth, healthForAccounts, healthOverview } from "../service";

/** M12 B3: Health overview, the health badges on a list page and the account Health tab. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Health queries do not grow with rows", () => {
  it("overview: same statements for a 2-account book as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) => healthOverview(actor));
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(8);
  });

  it("badges for a page of accounts: same statements for 2 ids as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      healthForAccounts(actor, ids),
    );
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(6);
  });

  it("account Health tab: bounded statements, same for any account", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      getAccountHealth(actor, ids[0]!),
    );
    expect(two.result).not.toBeNull();
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(24);
  });
});
