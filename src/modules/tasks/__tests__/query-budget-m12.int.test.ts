import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listAccountTasks, listMyTasks } from "../service";

/** M12 B3: the Tasks queue and the account Tasks tab read a fixed number of times (no N+1). */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Tasks queries do not grow with rows", () => {
  it("my open tasks: same statements for 2 owned accounts as for 5", async () => {
    const { two, five } = await twoVsFive(w, countQueries, (actor) => listMyTasks(actor, "OPEN"));
    expect(two.result.length).toBeGreaterThan(0);
    expect(five.result.length).toBeGreaterThan(two.result.length);
    expectBounded(five.queries, two.queries);
    expect(five.queries).toBeLessThanOrEqual(5);
  });

  it("account Tasks tab: statements do not grow when 4 more tasks are added", async () => {
    const accountId = w.bigAccounts[0]!;
    const before = await countQueries(() => listAccountTasks(w.big, accountId));
    await w.db.task.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({
        workspaceId: w.ctx.workspaceId,
        accountId,
        title: `Extra synthetic task ${i}`,
        ownerMembershipId: w.big.membershipId,
        origin: "HUMAN" as const,
      })),
    });
    const after = await countQueries(() => listAccountTasks(w.big, accountId));
    expect(after.result.length).toBe(before.result.length + 4);
    expectBounded(after.queries, before.queries);
  });
});
