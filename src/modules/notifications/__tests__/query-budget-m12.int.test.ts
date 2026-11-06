import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listMyNotifications } from "../service";

/** M12 B3: the notifications page is one read, capped at 50, whatever the backlog. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Notifications page does not grow with rows", () => {
  it("one statement for 2 notifications and for 60", async () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        workspaceId: w.ctx.workspaceId,
        recipientMembershipId: w.big.membershipId,
        type: "TASK_ASSIGNED" as never,
        title: `Synthetic notification ${i}`,
        refType: "task",
        refId: `budget-${i}`,
      }));
    await w.db.notification.createMany({ data: make(2) });
    const two = await countQueries(() => listMyNotifications(w.big));
    await w.db.notification.createMany({ data: make(58) });
    const sixty = await countQueries(() => listMyNotifications(w.big));
    expect(sixty.result).toHaveLength(50);
    expectBounded(sixty.queries, two.queries);
    expect(sixty.queries).toBe(1);
  });
});
