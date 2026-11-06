import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { writeAudit } from "@/lib/audit";
import { listAudit } from "../service";

/** M12 B3: the audit log page reads a fixed number of times; offset paging on a long log. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Audit log page does not grow with rows", () => {
  it("same statements for a short log and for 80 more entries, and page 2 works", async () => {
    const before = await countQueries(() => listAudit(w.admin, {}));
    for (let i = 0; i < 80; i++)
      await writeAudit({
        workspaceId: w.ctx.workspaceId,
        actorType: "SYSTEM",
        action: "budget.synthetic",
        summary: `Synthetic audit entry ${i}`,
      });
    const after = await countQueries(() => listAudit(w.admin, {}));
    expectBounded(after.queries, before.queries);
    expect(after.queries).toBeLessThanOrEqual(8);
    const rows = (r: typeof after.result) => (r as unknown as { rows: unknown[] }).rows;
    expect(rows(after.result).length).toBeGreaterThan(0);
  });
});
