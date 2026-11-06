import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listCampaigns } from "../service";

/** M12 B3: the Campaigns list reads a fixed number of times, whatever the number of campaigns. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Campaigns list does not grow with rows", () => {
  it("same statements for 1 campaign as for 4", async () => {
    const seg = await w.db.segment.create({
      data: {
        workspaceId: w.ctx.workspaceId,
        name: "Budget segment",
        createdByMembershipId: w.admin.membershipId,
        filter: {},
      } as never,
    });
    const make = (i: number) =>
      w.db.campaign.create({
        data: {
          workspaceId: w.ctx.workspaceId,
          name: `Budget campaign ${i}`,
          segmentId: seg.id,
          subject: `Synthetic subject ${i}`,
          body: "Synthetic body",
          createdById: w.admin.membershipId,
        },
      });
    await make(0);
    const one = await countQueries(() => listCampaigns(w.admin));
    for (const i of [1, 2, 3]) await make(i);
    const four = await countQueries(() => listCampaigns(w.admin));
    expect(one.result).toHaveLength(1);
    expect(four.result).toHaveLength(4);
    expectBounded(four.queries, one.queries);
    expect(four.queries).toBeLessThanOrEqual(6);
  });
});
