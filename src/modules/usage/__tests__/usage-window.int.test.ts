import { beforeAll, describe, expect, it } from "vitest";
import { calendarDateOf } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { getUsage } from "../service";

/**
 * A health reason's source link opens the Usage tab for the reason's own window (M3 rule 2):
 * the people count, the most-active list and feature use must be that window's, not "the last
 * 28 days to now", or the proof would show a different number from the reason.
 */
const AS_OF = new Date("2026-11-02T14:00:00Z");
const day = (n: number) => new Date(Date.UTC(2026, 10, 2) - n * 86_400_000);
let actor: Actor;
let accountId: string;

beforeAll(async () => {
  actor = (await createTestAdmin("UsageWindow")).actor;
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  accountId = (
    await db.account.create({
      data: { workspaceId: ws, name: "Windowed", tier: "MID_TOUCH", plan: "Growth" },
    })
  ).id;
  await db.featureCatalog.create({
    data: { workspaceId: ws, featureKey: "alerts", label: "Alerts", includedInPlans: ["Growth"] },
  });
  const rows: Array<[string, number]> = [
    ...[1, 2, 3, 4, 5].map((d) => ["u1", d] as [string, number]),
    ...[20, 21, 22].map((d) => ["u2", d] as [string, number]),
    ["u3", 0], // today only: outside a window ending yesterday
  ];
  for (const [u, d] of rows)
    await db.userUsageDaily.create({
      data: {
        workspaceId: ws,
        accountId,
        externalUserId: u,
        date: day(d),
        events: 10,
        sessions: 1,
      },
    });
  for (const d of [0, 21])
    await db.featureUsageDaily.create({
      data: { workspaceId: ws, accountId, featureKey: "alerts", date: day(d), users: 1, events: 3 },
    });
});

describe("usage for a reason's window", () => {
  it("without a window: the last 28 days up to now", async () => {
    const u = await getUsage(actor, accountId, AS_OF);
    expect(u.period).toBeNull();
    expect(u.activeUsers28d).toBe(3);
    expect(u.topUsers.map((t) => t.externalUserId).sort()).toEqual(["u1", "u2", "u3"]);
    expect(u.features.find((f) => f.key === "alerts")?.daysUsed28d).toBe(2);
  });

  it("with a window: counts, people and features are that window's only (both ends included)", async () => {
    const window = { from: calendarDateOf(day(22)), to: calendarDateOf(day(1)) };
    const u = await getUsage(actor, accountId, AS_OF, window);
    expect(u.period).toEqual(window);
    expect(u.activeUsers28d).toBe(2);
    expect(u.topUsers.map((t) => t.externalUserId).sort()).toEqual(["u1", "u2"]);
    expect(u.features.find((f) => f.key === "alerts")).toMatchObject({ daysUsed28d: 1 });
  });
});
