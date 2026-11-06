import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getAccountOnboarding } from "../plans.service";

/** M12 B3: the account Onboarding tab reads a fixed number of times for any account. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Account onboarding tab does not grow with rows", () => {
  it("same statements for every account of a book", async () => {
    const counts: number[] = [];
    for (const id of w.bigAccounts)
      counts.push((await countQueries(() => getAccountOnboarding(w.big, id))).queries);
    expect(new Set(counts).size).toBeLessThanOrEqual(2); // with a plan or without
    expect(Math.max(...counts)).toBeLessThanOrEqual(20);
  });
});
