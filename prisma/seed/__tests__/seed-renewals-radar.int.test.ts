import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import {
  getAccountRenewals,
  listRenewals,
  RenewalError,
  setForecastCategory,
} from "@/modules/renewals/service";
import { runSeed } from "../run";

/**
 * The renewal radar on the seed (M7 A5, D-120 correction). As of 2026-11-02 Northgate Freight is
 * one of seven renewals tied at the lowest confidence (70) in the next 90 days. The test asserts
 * that tie group, Northgate's membership and the reasons the data yields, and nothing stronger:
 * no LOW band and no "lowest alone" until M9/M10 data (promise extraction, call transcripts).
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });
const clock = () => new Date("2026-11-02T17:00:00Z");

async function actorFor(role: "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER", revenue: boolean) {
  const m = await db().membership.findFirstOrThrow({
    where: { role, canViewRevenue: revenue, status: "ACTIVE" },
  });
  return { ...m, workspaceId: ws, membershipId: m.id } as unknown as Actor;
}

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 240_000);

describe("renewal radar on the seed", () => {
  it("lists the seven-way tie at confidence 70 with ARR and date, Northgate among them", async () => {
    const admin = await actorFor("ADMIN", true);
    const list = await listRenewals(admin, { days: 90 }, clock);
    const lowest = Math.min(...list.rows.map((r) => r.confidence));
    expect(lowest).toBe(70);
    const tie = list.rows.filter((r) => r.confidence === lowest);
    expect(tie.map((r) => r.account.name).sort()).toEqual(
      [
        "Aspenwood Fitness",
        "Beaconcrest Transport",
        "Harborbrook Solicitors",
        "Harborwood Accounting",
        "Larkwood Works",
        "Meridianhaven Consulting",
        "Northgate Freight",
      ].sort(),
    );
    // Ordered by date within the tie, ARR from the contract records.
    const dates = tie.map((r) => r.renewalDate.toISOString().slice(0, 10));
    expect(dates).toEqual([...dates].sort());
    const north = tie.find((r) => r.account.name === "Northgate Freight")!;
    expect(dates[tie.indexOf(north)]).toBe("2026-12-13");
    expect(north.arrMinor).toBe(14_200_000n);
    expect(north.band).toBe("HIGH");
    // Reasons as the data yields them: health Healthy, notice deadline with no plan, promises null.
    const byKey = Object.fromEntries(north.reasons.map((f) => [f.key, f]));
    expect(byKey.health_band!.points).toBe(10);
    expect(byKey.notice!.points).toBe(-10);
    expect(byKey.promises!.points).toBeNull();
    for (const f of north.reasons) expect(f.reason.length).toBeGreaterThan(0);
  });

  it("sums the forecast from the listed renewals and keeps people's categories apart from bands", async () => {
    const admin = await actorFor("ADMIN", true);
    const list = await listRenewals(admin, { days: 90 }, clock);
    const f = list.forecast!;
    const ids90 = new Set(list.rows.map((r) => r.id));
    const counted = [
      ...f.omittedIds,
      ...f.noArrIds,
      ...Object.values(f.byBand).flatMap((b) => b.renewalIds),
      ...f.otherCurrencies.flatMap((o) => o.renewalIds),
    ];
    expect(new Set(counted).size).toBe(counted.length);
    if (list.total <= list.rows.length) for (const id of counted) expect(ids90.has(id)).toBe(true);
    expect(f.byBand.LOW.renewalIds).toEqual([]);
  });

  it("a member without revenue access gets no money and no forecast", async () => {
    const csm = await actorFor("CSM", false);
    const list = await listRenewals(csm, { days: 365 }, clock);
    expect(list.forecast).toBeNull();
    expect(list.moneyVisible).toBe(false);
    for (const r of list.rows) {
      expect(r).not.toHaveProperty("arrMinor");
      expect(r).not.toHaveProperty("currency");
      expect(r.moneyVisible).toBe(false);
    }
  });

  it("the owner, a CS Leader or an Admin may categorise; the disagreement is flagged, audited, and the band untouched", async () => {
    const admin = await actorFor("ADMIN", true);
    const viewer = await actorFor("VIEWER", false);
    const row = (await listRenewals(admin, { days: 90 }, clock)).rows.find(
      (r) => r.account.name === "Northgate Freight",
    )!;
    await expect(setForecastCategory(viewer, row.id, { category: "AT_RISK" })).rejects.toThrow();
    await expect(setForecastCategory(admin, row.id, { category: "BOGUS" })).rejects.toThrow();
    await expect(
      setForecastCategory(admin, "nope", { category: "AT_RISK" }),
    ).rejects.toBeInstanceOf(RenewalError);
    await setForecastCategory(admin, row.id, { category: null }); // repeatable: start from none
    await setForecastCategory(admin, row.id, { category: "AT_RISK", note: "Champion wavering" });
    const after = (await getAccountRenewals(admin, row.account.id, clock)).open[0]!;
    expect(after.category).toBe("AT_RISK");
    expect(after.confidence).toBe(row.confidence);
    expect(after.band).toBe(row.band);
    expect(after.disagreement).toMatchObject({
      band: "HIGH",
      suggests: "COMMIT",
      chosen: "AT_RISK",
    });
    const audit = await db().auditLog.findFirstOrThrow({
      where: { action: "renewal.forecast_category_set", targetId: row.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.after).toMatchObject({ category: "AT_RISK", note: "Champion wavering" });
    expect(audit.before).toMatchObject({ category: null });
    await setForecastCategory(admin, row.id, { category: null });
  });
});
