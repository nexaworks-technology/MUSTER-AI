import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { getUsage } from "../service";

const AS_OF = new Date("2026-11-02T14:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 10, 2) - n * 86_400_000);
let actor: Actor;
let withUsage: string;
let withoutUsage: string;
let otherWorkspaceAccount: string;

beforeAll(async () => {
  actor = (await createTestAdmin("Usage")).actor;
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  withUsage = (
    await db.account.create({
      data: { workspaceId: ws, name: "Busy", tier: "MID_TOUCH", plan: "Growth" },
    })
  ).id;
  withoutUsage = (
    await db.account.create({
      data: { workspaceId: ws, name: "Quiet", tier: "MID_TOUCH", plan: "Growth" },
    })
  ).id;
  await db.contract.create({
    data: { workspaceId: ws, accountId: withUsage, startDate: day(200), seatsPurchased: 10 },
  });
  await db.featureCatalog.createMany({
    data: [
      {
        workspaceId: ws,
        featureKey: "dashboards",
        label: "Dashboards",
        isKeyFeature: true,
        includedInPlans: ["Growth"],
      },
      { workspaceId: ws, featureKey: "sso", label: "SSO", includedInPlans: ["Scale"] },
    ],
  });
  for (let d = 0; d < 30; d++) {
    await db.usageDaily.create({
      data: {
        workspaceId: ws,
        accountId: withUsage,
        date: day(d),
        activeUsers: d < 14 ? 2 : 6,
        sessions: 5,
        events: 40,
      },
    });
    for (const u of d < 14 ? ["u1", "u2"] : ["u1", "u2", "u3"]) {
      await db.userUsageDaily.create({
        data: {
          workspaceId: ws,
          accountId: withUsage,
          externalUserId: u,
          date: day(d),
          events: u === "u1" ? 9 : 2,
          sessions: 1,
        },
      });
    }
  }
  await db.featureUsageDaily.create({
    data: {
      workspaceId: ws,
      accountId: withUsage,
      featureKey: "dashboards",
      date: day(3),
      users: 2,
      events: 10,
    },
  });
  const other = await createTestAdmin("UsageOther");
  otherWorkspaceAccount = (
    await scopedDb(other.actor).account.create({
      data: { workspaceId: other.actor.workspaceId, name: "X", tier: "LONG_TAIL" },
    })
  ).id;
});

describe("usage read model", () => {
  it("weekly active people, 28-day actives vs seats, key features and top users come from real rows", async () => {
    const usage = await getUsage(actor, withUsage, AS_OF);
    expect(usage.hasData).toBe(true);
    expect(usage.metric).toBe("distinct-users");
    expect(usage.weekly.length).toBeGreaterThanOrEqual(5);
    expect(usage.activeUsers28d).toBe(3);
    expect(usage.seatsPurchased).toBe(10);
    expect(usage.features).toEqual([
      expect.objectContaining({ key: "dashboards", inPlan: true, daysUsed28d: 1, isKey: true }),
    ]);
    expect(usage.topUsers[0]).toMatchObject({ externalUserId: "u1" });
  });

  it("an account with no usage rows has no data — nothing is filled in (Rule 6)", async () => {
    const usage = await getUsage(actor, withoutUsage, AS_OF);
    // No user-level rows means "unknown" (null), never zero active users (Rule 4).
    expect(usage).toMatchObject({ hasData: false, weekly: [], activeUsers28d: null, topUsers: [] });
    expect(usage.features.every((f) => f.daysUsed28d === 0)).toBe(true);
  });

  it("uses a fixed number of queries", async () => {
    const { queries } = await countQueries(() => getUsage(actor, withUsage, AS_OF));
    expect(queries).toBeLessThanOrEqual(10);
  });

  it("another workspace's account is not found", async () => {
    await expect(getUsage(actor, otherWorkspaceAccount, AS_OF)).rejects.toThrow(/not found/);
  });
});
