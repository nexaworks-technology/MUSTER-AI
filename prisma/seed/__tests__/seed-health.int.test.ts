import { beforeAll, describe, expect, it } from "vitest";
import { utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { runSeed } from "../run";
import { SEED_TODAY } from "../demo/dates";
import { ids } from "../demo/ids";
import { ROSTER } from "../demo/roster";

/**
 * Seed v2 (M3, SEED_DATA §3 and §8, founder decisions 1 and 7): the data-derived renewals are the
 * documented 12, every active contract renews within 12 months, the Pulses and the Brightwell
 * outside signal are there, every active account has a snapshot for SEED_TODAY, and re-seeding
 * adds no signals (the nightly job is idempotent).
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 180_000);

describe("seed v2 — health and signals", () => {
  it("every active seeded contract's next renewal is within 12 months", async () => {
    const today = utcMidnight(SEED_TODAY);
    const yearOut = new Date(today.getTime() + 366 * 86_400_000);
    const active = await db().contract.findMany({
      where: { status: "ACTIVE", account: { lifecycleStage: { not: "LOST" }, source: "SEED" } },
      select: { accountId: true, renewalDate: true },
    });
    const next = new Map<string, Date>();
    for (const c of active)
      if (c.renewalDate && c.renewalDate >= today) {
        const prev = next.get(c.accountId);
        if (!prev || c.renewalDate < prev) next.set(c.accountId, c.renewalDate);
      }
    expect([...next.values()].filter((d) => d > yearOut)).toEqual([]);
  });

  it("the documented renewals each have a contract that starts the day the previous one ended", async () => {
    const renewed = ROSTER.filter((a) => a.renewedDaysAgo !== undefined);
    expect(renewed).toHaveLength(12);
    for (const a of renewed) {
      const cs = await db().contract.findMany({
        where: { accountId: ids.account(a.key) },
        orderBy: { startDate: "asc" },
      });
      expect(
        cs.some((c, i) => i > 0 && c.startDate.getTime() === cs[i - 1]!.endDate!.getTime()),
        a.name,
      ).toBe(true);
    }
  });

  it("seeds the two Pulses and the Brightwell outside signal with its public source", async () => {
    const pulses = await db().csmPulse.findMany({
      where: { accountId: { in: [ids.account("tidewater"), ids.account("ashgrove")] } },
      orderBy: { value: "asc" },
    });
    expect(pulses.map((p) => [p.value, p.comment])).toEqual([
      ["FINE", "Spike was one migration, resolved"],
      ["WORRIED", "New VP is skeptical"],
    ]);
    const outside = await db().signal.findMany({
      where: { accountId: ids.account("brightwell"), ruleKey: "outside_event" },
    });
    expect(outside).toHaveLength(1);
    expect(outside[0]!.evidence).toEqual([
      {
        sourceType: "PublicSource",
        value: "https://news.example.test/haverford-brightwell",
        date: "2026-10-20",
      },
    ]);
  });

  it("every active account has a current snapshot for SEED_TODAY, and At Risk always has a reason", async () => {
    const accounts = await db().account.findMany({
      where: { lifecycleStage: { not: "LOST" }, source: "SEED" },
      select: {
        id: true,
        currentHealth: { select: { asOf: true, riskLevel: true, riskReasonId: true } },
      },
    });
    expect(accounts).toHaveLength(60);
    for (const a of accounts) {
      expect(a.currentHealth?.asOf).toEqual(utcMidnight(SEED_TODAY));
      if (a.currentHealth?.riskLevel === "AT_RISK")
        expect(a.currentHealth.riskReasonId).not.toBeNull();
    }
  });

  it("re-seeding creates no duplicate signals and no new snapshots", async () => {
    const count = async () => ({
      signals: await db().signal.count(),
      live: await db().signal.count({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      snapshots: await db().healthScoreSnapshot.count(),
    });
    const before = await count();
    expect(before.signals).toBeGreaterThan(0);
    await runSeed({ includeTestTenant: false });
    expect(await count()).toEqual(before);
  }, 180_000);
});
