import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { accountListQuery } from "@/modules/accounts/schemas";
import { listAccounts, type Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { createSegment, filterFromListQuery, segmentWhere } from "../service";

let a: Actor;
let b: Actor;
let segmentId: string;

beforeAll(async () => {
  a = (await createTestAdmin("SegA")).actor;
  b = (await createTestAdmin("SegB")).actor;
  for (const actor of [a, b]) {
    await scopedDb(actor).account.createMany({
      data: [
        {
          workspaceId: actor.workspaceId,
          name: "LT adopting 1",
          tier: "LONG_TAIL",
          lifecycleStage: "ADOPTING",
        },
        {
          workspaceId: actor.workspaceId,
          name: "LT adopting 2",
          tier: "LONG_TAIL",
          lifecycleStage: "ADOPTING",
        },
        {
          workspaceId: actor.workspaceId,
          name: "LT mature",
          tier: "LONG_TAIL",
          lifecycleStage: "MATURE",
        },
        {
          workspaceId: actor.workspaceId,
          name: "Mid adopting",
          tier: "MID_TOUCH",
          lifecycleStage: "ADOPTING",
        },
      ],
    });
  }
  const filter = filterFromListQuery({ tier: "LONG_TAIL", stage: "ADOPTING" })!;
  segmentId = (await createSegment(a, { name: "Long-tail adopting", filter })).id;
});

describe("segments", () => {
  it("a saved segment filters the Accounts list to exactly its accounts, in this workspace only", async () => {
    const page = await listAccounts(a, accountListQuery.parse({ segment: segmentId }));
    expect(page.segmentName).toBe("Long-tail adopting");
    expect(page.rows.map((r) => r.name).sort()).toEqual(["LT adopting 1", "LT adopting 2"]);
  });

  it("another workspace cannot use the segment (it does not exist there)", async () => {
    expect(await segmentWhere(b, segmentId)).toBeNull();
    const page = await listAccounts(b, accountListQuery.parse({ segment: segmentId }));
    expect(page.segmentMissing).toBe(true);
  });

  it("names are unique per workspace and an ARR filter needs revenue access", async () => {
    await expect(
      createSegment(a, {
        name: "Long-tail adopting",
        filter: { all: [{ field: "tier", op: "eq", value: "MID_TOUCH" }] },
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      createSegment(
        { ...a, canViewRevenue: false },
        { name: "Big", filter: { all: [{ field: "arr", op: "gte", value: 50_000 }] } },
      ),
    ).rejects.toThrow(/revenue/);
  });

  it("a Viewer cannot save segments", async () => {
    await expect(
      createSegment(
        { ...a, role: "VIEWER" },
        { name: "x", filter: { all: [{ field: "tier", op: "eq", value: "LONG_TAIL" }] } },
      ),
    ).rejects.toThrow(/accounts:edit/);
  });
});
