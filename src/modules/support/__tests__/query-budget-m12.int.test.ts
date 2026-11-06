import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listTickets } from "../service";

/** M12 B3: Account 360 Tickets tab: statements do not grow when 4 more tickets are added. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Tickets tab does not grow with rows", () => {
  it("same statements before and after adding 4 tickets", async () => {
    const accountId = w.bigAccounts[0]!;
    const before = await countQueries(() => listTickets(w.big, accountId));
    await w.db.ticket.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({
        workspaceId: w.ctx.workspaceId,
        accountId,
        subject: `Extra synthetic ticket ${i}`,
        openedAt: new Date("2026-10-30T10:00:00Z"),
      })),
    });
    const after = await countQueries(() => listTickets(w.big, accountId));
    expect(after.result.length).toBe(before.result.length + 4);
    expectBounded(after.queries, before.queries);
    expect(after.queries).toBeLessThanOrEqual(4);
  });
});
