import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listPlays } from "../service";

/** M12 B3: the Plays list reads a fixed number of times, whatever the number of plays. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Plays list does not grow with rows", () => {
  it("is bounded and the same for two actors", async () => {
    const a = await countQueries(() => listPlays(w.small));
    const b = await countQueries(() => listPlays(w.admin));
    expect(a.result.length).toBeGreaterThan(0);
    expectBounded(b.queries, a.queries);
    expect(b.queries).toBeLessThanOrEqual(8);
  });
});
