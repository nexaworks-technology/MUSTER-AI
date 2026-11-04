import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import {
  exportOpportunity,
  ExpansionError,
  getAccountExpansion,
  listOpportunities,
} from "@/modules/expansion/service";
import { countQueries } from "@/test/query-counter";
import { runSeed } from "../run";

/**
 * Expansion on the seed (M7 B1/B2). Copperleaf Studios is the one account with expansion signals:
 * 52 people in the last 28 days on 40 seats, a burst of new people, and growth against its own
 * normal. Its estimate is asserted from the records themselves (contract seats, the subscription's
 * price and quantity, the distinct people in usage), never from a typed-in figure. No seeded goal is
 * measured in seats or users, so GOAL_STATED_EXPANSION has no seed row and is carried by its
 * golden fixtures (founder D7).
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });
const clock = () => new Date("2026-11-02T17:00:00Z");
const asActor = (m: { id: string }) =>
  ({ ...m, workspaceId: ws, membershipId: m.id }) as unknown as Actor;
const admin = async () =>
  asActor(
    await db().membership.findFirstOrThrow({
      where: { role: "ADMIN", canViewRevenue: true, status: "ACTIVE" },
    }),
  );
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 240_000);

describe("expansion on the seed", () => {
  it("Copperleaf: 12 seats over at the price on its own subscription, asserted from the records", async () => {
    const copper = await db().account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } });
    const contract = await db().contract.findFirstOrThrow({
      where: { accountId: copper.id, status: "ACTIVE" },
    });
    const subs = await db().subscription.findMany({
      where: { accountId: copper.id, status: "ACTIVE" },
    });
    expect(subs).toHaveLength(1);
    const perSeat = subs[0]!.amountMinor / BigInt(subs[0]!.quantity);
    const people = await db().userUsageDaily.groupBy({
      by: ["externalUserId"],
      where: {
        accountId: copper.id,
        events: { gt: 0 },
        date: { gte: new Date("2026-10-05T00:00:00Z"), lt: new Date("2026-11-02T00:00:00Z") },
      },
    });
    const over = people.length - contract.seatsPurchased!;
    expect({ seats: contract.seatsPurchased, over, perSeat }).toEqual({
      seats: 40,
      over: 12,
      perSeat: 90_000n,
    });
    const opp = await db().expansionOpportunity.findFirstOrThrow({
      where: { accountId: copper.id },
    });
    expect(opp).toMatchObject({
      estimateMinor: BigInt(over) * perSeat,
      currency: "USD",
      estimateMethod: "SEATS_OVER_LIMIT",
      isEstimate: true,
      status: "OPEN",
    });
    expect(opp.estimateMinor).toBe(1_080_000n);
  });

  it("lists it as an estimate with its method and the signals behind it; it is the only open opportunity", async () => {
    const list = await listOpportunities(await admin(), {}, clock);
    expect(list.rows.map((r) => r.account.name)).toEqual(["Copperleaf Studios"]);
    const row = list.rows[0]!;
    expect(row.estimateText).toBe(
      "Estimate: $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription)",
    );
    expect(row.signals.map((s) => s.ruleKey).sort()).toEqual([
      "fast_growth",
      "new_team_using",
      "seats_near_limit",
    ]);
    expect(row.signals.every((s) => s.live)).toBe(true);
  });

  it("no seeded goal is measured in seats or users: the goal rule has no seed row", async () => {
    expect(await db().goal.count({ where: { metricKey: { in: ["seats", "users"] } } })).toBe(0);
    expect(await db().signal.count({ where: { ruleKey: "goal_stated_expansion" } })).toBe(0);
  });

  it("the whitespace panel shows the 12 seats over and carries no money", async () => {
    const copper = await db().account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } });
    const tab = await getAccountExpansion(await admin(), copper.id, clock);
    expect(tab.whitespace.seats).toMatchObject({
      state: "OK",
      purchased: 40,
      inUse: 52,
      headroom: -12,
    });
    expect(json(tab.whitespace)).not.toMatch(/minor|price|arr|currency|\$/i);
  });

  it("without revenue access the page has no money key and no figure", async () => {
    const viewer = { ...(await admin()), canViewRevenue: false } as Actor;
    const list = await listOpportunities(viewer, {}, clock);
    const text = json(list);
    expect(list.moneyVisible).toBe(false);
    expect(text).not.toMatch(/1080000|10,800|\$900|900\.00|estimateMinor|estimateText/);
    const copper = await db().account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } });
    expect(json(await getAccountExpansion(viewer, copper.id, clock))).not.toMatch(
      /1080000|10,800|\$900|900\.00|estimateMinor|estimateText/,
    );
    await expect(exportOpportunity(viewer, list.rows[0]!.id)).rejects.toThrow();
  });

  it("export with no CRM connected is refused with the way forward", async () => {
    const list = await listOpportunities(await admin(), {}, clock);
    const err = await exportOpportunity(await admin(), list.rows[0]!.id).catch((e) => e);
    expect(err).toBeInstanceOf(ExpansionError);
    expect(err.message).toMatch(/connect|Turn on write-back/i);
  });

  it("query count per page does not depend on the status filter or the rows", async () => {
    const a = await admin();
    const open = await countQueries(() => listOpportunities(a, { status: "OPEN" }, clock));
    const all = await countQueries(() => listOpportunities(a, { status: "ALL" }, clock));
    expect(open.queries).toBe(all.queries);
    // rows, count, CRMs, signals, whitespace (6 reads) and the Finder's runs: fixed per page.
    expect(open.queries).toBeLessThanOrEqual(15);
  });
});
