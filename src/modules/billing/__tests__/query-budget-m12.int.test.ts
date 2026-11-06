import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getBilling } from "../service";

/** M12 B3: Account 360 Billing tab: statements do not grow when 4 more invoices are added. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Billing tab does not grow with rows", () => {
  it("same statements before and after adding 4 invoices", async () => {
    const accountId = w.bigAccounts[0]!;
    const before = await countQueries(() => getBilling(w.admin, accountId));
    await w.db.invoice.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({
        workspaceId: w.ctx.workspaceId,
        accountId,
        number: `BUDGET-${i}`,
        amountMinor: 100_000n,
        issuedAt: new Date("2026-09-01T10:00:00Z"),
        dueAt: new Date("2026-10-01T10:00:00Z"),
        status: "PAID" as const,
      })),
    });
    const after = await countQueries(() => getBilling(w.admin, accountId));
    expectBounded(after.queries, before.queries);
    expect(after.queries).toBeLessThanOrEqual(10);
  });
});
