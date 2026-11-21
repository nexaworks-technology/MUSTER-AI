import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countMyRenewalsDue, getToday } from "@/modules/today/service";
import { getAccountRenewals, listRenewals } from "../service";
import { syncRenewals } from "../sync.service";

/**
 * DEMO-WALKTHROUGH FAIL 29 (Quarry Lane): a renewal whose date has passed and that is still open
 * (no successor contract, contract still active) vanished from the Renewals page, its forecast and
 * Today, and the nightly sync stopped refreshing its confidence. It is overdue, not gone.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const clock = () => new Date("2026-11-21T15:00:00Z");

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${label} Quarry`,
      tier: "MID_TOUCH",
      ownerMembershipId: actor.membershipId,
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d("2025-11-09"),
      endDate: d("2026-11-09"),
      renewalDate: d("2026-11-09"),
      noticePeriodDays: 30,
      valueMinor: 2_400_000n,
      seatsPurchased: 10,
    },
  });
  return { actor, db, account, contract };
}

describe("overdue open renewals", () => {
  it("the nightly sync keeps refreshing an open renewal after its date has passed", async () => {
    const w = await world("OverdueSync");
    expect(await syncRenewals(w.actor, [w.account.id], "2026-10-20")).toMatchObject({
      created: 1,
    });
    const before = await w.db.renewal.findFirstOrThrow({ where: { accountId: w.account.id } });
    await syncRenewals(w.actor, [w.account.id], "2026-11-21");
    const after = await w.db.renewal.findFirstOrThrow({ where: { accountId: w.account.id } });
    expect(after.id).toBe(before.id);
    expect(after.stage).toBe("UPCOMING");
    expect(after.confidenceAsOf.toISOString().slice(0, 10)).toBe("2026-11-21");
    const notice = (after.confidenceReasons as Array<{ key: string; reason: string }>).find(
      (r) => r.key === "notice",
    )!;
    expect(notice.reason).toMatch(/passed .* ago/);
  });

  it("does not invent a renewal for a contract whose date passed before it was ever tracked", async () => {
    const w = await world("OverdueNew");
    await syncRenewals(w.actor, [w.account.id], "2026-11-21");
    expect(await w.db.renewal.count({ where: { accountId: w.account.id } })).toBe(0);
  });

  it("is listed as overdue on the Renewals page at every window, in the forecast and on Today", async () => {
    const w = await world("OverdueList");
    await syncRenewals(w.actor, [w.account.id], "2026-10-20");
    for (const days of [30, 60, 90, 180, 365]) {
      const page = await listRenewals(w.actor, { days }, clock);
      const row = page.rows.find((r) => r.account.id === w.account.id);
      expect(row, `window ${days}`).toBeDefined();
      expect(row!.overdue).toBe(true);
      expect(row!.daysToRenewal).toBe(-12);
      const inForecast = Object.values(page.forecast!.byBand).flatMap((b) => b.renewalIds);
      expect(inForecast).toContain(row!.id);
    }
    expect(await countMyRenewalsDue(w.actor, 30, clock)).toBe(1);
    const today = (await getToday(w.actor, { clock })).find((s) => s.key === "RENEWAL")!;
    expect(today.items.map((i) => i.accountId)).toContain(w.account.id);
  });

  it("the account's Renewal tab marks it overdue", async () => {
    const w = await world("OverdueTab");
    await syncRenewals(w.actor, [w.account.id], "2026-10-20");
    const tab = await getAccountRenewals(w.actor, w.account.id, clock);
    expect(tab.open[0]).toMatchObject({ overdue: true, daysToRenewal: -12 });
  });

  it("a renewed or churned renewal is never shown as overdue", async () => {
    const w = await world("OverdueClosed");
    await syncRenewals(w.actor, [w.account.id], "2026-10-20");
    await w.db.renewal.updateMany({
      where: { accountId: w.account.id },
      data: { stage: "CHURNED" },
    });
    const page = await listRenewals(w.actor, { days: 365 }, clock);
    expect(page.rows.find((r) => r.account.id === w.account.id)).toBeUndefined();
  });
});
