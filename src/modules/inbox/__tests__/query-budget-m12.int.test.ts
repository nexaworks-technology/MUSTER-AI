import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listUnmatched } from "../service";

/** M12 B3: the Unmatched mail list reads a fixed number of times (the Inbox list itself: list.int.test.ts). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Unmatched list is bounded", () => {
  it("is a bounded number of statements for an empty queue", async () => {
    const r = await countQueries(() => listUnmatched(w.admin));
    expect(r.queries).toBeLessThanOrEqual(5);
  });
});
