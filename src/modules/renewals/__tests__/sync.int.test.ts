import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { syncRenewals } from "../sync.service";

/**
 * M7 A4: renewals.sync. Rows for renewals in the next year with deterministic confidence and its
 * sourced reasons; no guess for a contract with no renewal date (Rule 4); idempotent; outcomes
 * detected from contract records only, as append-only rows carrying the forecast as it stood
 * (M7 rule 7); never opens signals; scoped to the workspace.
 */
const NOW = "2026-11-02";
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = async (name: string) =>
    db.account.create({ data: { workspaceId: ws, name: `${label} ${name}`, tier: "MID_TOUCH" } });
  const contract = (accountId: string, over: Record<string, unknown> = {}) =>
    db.contract.create({
      data: {
        workspaceId: ws,
        accountId,
        startDate: d("2025-12-13"),
        endDate: d("2026-12-13"),
        renewalDate: d("2026-12-13"),
        noticePeriodDays: 30,
        valueMinor: 14_200_000n,
        seatsPurchased: 10,
        ...over,
      },
    });
  return { actor, db, ws, account, contract };
}

describe("renewals.sync", () => {
  it("creates a row with confidence, band, reasons and a source on every reason; a re-run changes nothing", async () => {
    const w = await world("SyncA");
    const a = await w.account("Northgate-like");
    const c = await w.contract(a.id);
    const first = await syncRenewals(w.actor, [a.id], NOW);
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const row = await w.db.renewal.findFirstOrThrow({ where: { contractId: c.id } });
    expect(row).toMatchObject({
      accountId: a.id,
      arrAtRiskMinor: 14_200_000n,
      currency: "USD",
      stage: "UPCOMING",
      forecastCategory: null,
    });
    expect(row.renewalDate.toISOString().slice(0, 10)).toBe("2026-12-13");
    expect(row.noticeDeadline!.toISOString().slice(0, 10)).toBe("2026-11-13");
    const reasons = row.confidenceReasons as Array<{
      key: string;
      sources: unknown[];
      points: number | null;
    }>;
    expect(reasons.map((r) => r.key)).toEqual([
      "health_band",
      "health_trend",
      "signals",
      "champion",
      "promises",
      "invoices",
      "notice",
      "usage",
    ]);
    for (const r of reasons) expect(r.sources.length).toBeGreaterThan(0);
    // Nothing known beyond a notice deadline in 11 days with no plan: 70 base − 10, the simple model.
    expect(reasons.find((r) => r.key === "notice")!.points).toBe(-10);
    const again = await syncRenewals(w.actor, [a.id], NOW);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it("a plan raises the notice factor and the next run updates the row", async () => {
    const w = await world("SyncPlan");
    const a = await w.account("Planned");
    await w.contract(a.id);
    await syncRenewals(w.actor, [a.id], NOW);
    const before = await w.db.renewal.findFirstOrThrow({ where: { accountId: a.id } });
    await w.db.renewal.update({
      where: { id: before.id },
      data: { planSteps: [{ title: "Confirm renewal call", dueDate: "2026-11-09" }] },
    });
    expect(await syncRenewals(w.actor, [a.id], NOW)).toMatchObject({ updated: 1 });
    const after = await w.db.renewal.findFirstOrThrow({ where: { accountId: a.id } });
    expect(after.confidence - before.confidence).toBe(15); // −10 becomes +5
  });

  it("makes no row, and no guess, for a contract with no renewal date or one beyond the horizon", async () => {
    const w = await world("SyncGap");
    const none = await w.account("No date");
    const far = await w.account("Far");
    await w.contract(none.id, { renewalDate: null, endDate: null });
    await w.contract(far.id, { renewalDate: d("2028-01-01"), endDate: d("2028-01-01") });
    expect(await syncRenewals(w.actor, [none.id, far.id], NOW)).toMatchObject({ created: 0 });
    expect(await w.db.renewal.count()).toBe(0);
  });

  it("detects a renewal from a later contract and freezes the forecast (human category included)", async () => {
    const w = await world("SyncWon");
    const a = await w.account("Renews");
    const old = await w.contract(a.id, {
      startDate: d("2025-11-20"),
      endDate: d("2026-11-20"),
      renewalDate: d("2026-11-20"),
    });
    await syncRenewals(w.actor, [a.id], NOW);
    const row = await w.db.renewal.findFirstOrThrow({ where: { accountId: a.id } });
    await w.db.renewal.update({
      where: { id: row.id },
      data: {
        forecastCategory: "COMMIT",
        forecastSetAt: new Date(),
        forecastSetByMembershipId: w.actor.membershipId,
      },
    });
    const stored = await w.db.renewal.findUniqueOrThrow({ where: { id: row.id } });
    // The successor starts when the old contract ends.
    await w.contract(a.id, {
      startDate: d("2026-11-20"),
      endDate: d("2027-11-20"),
      renewalDate: d("2027-11-20"),
      valueMinor: 16_800_000n,
    });
    await w.db.contract.update({ where: { id: old.id }, data: { status: "ENDED" } });
    const out = await syncRenewals(w.actor, [a.id], "2026-11-21");
    expect(out).toMatchObject({ renewed: 1 });
    const outcome = await w.db.renewalOutcome.findFirstOrThrow({ where: { renewalId: row.id } });
    expect(outcome).toMatchObject({
      result: "RENEWED",
      detectedVia: "CONTRACT_RECORDS",
      outcomeArrMinor: 16_800_000n,
      forecastConfidence: stored.confidence,
      forecastBand: stored.confidenceBand,
      forecastCategory: "COMMIT",
      forecastArrAtRiskMinor: 14_200_000n,
      supersedesId: null,
    });
    expect(outcome.forecastAsOf.toISOString().slice(0, 10)).toBe(NOW);
    expect(outcome.occurredOn.toISOString().slice(0, 10)).toBe("2026-11-20");
    expect(JSON.stringify(outcome.forecastReasons)).toBe(JSON.stringify(stored.confidenceReasons));
    expect((await w.db.renewal.findUniqueOrThrow({ where: { id: row.id } })).stage).toBe("RENEWED");
    // Terminal: running again records nothing more, and the row is not recomputed.
    expect(await syncRenewals(w.actor, [a.id], "2026-11-22")).toMatchObject({
      renewed: 0,
      churned: 0,
    });
    expect(await w.db.renewalOutcome.count({ where: { renewalId: row.id } })).toBe(1);
    // Append-only: the original cannot be edited.
    await expect(
      w.db.renewalOutcome.updateMany({ where: { id: outcome.id }, data: { note: "edited" } }),
    ).rejects.toThrow(/immutable/);
  });

  it("detects churn only from an ended or cancelled contract with no successor; a lapsed date alone is not a lost customer", async () => {
    const w = await world("SyncLost");
    const lost = await w.account("Lost");
    const lapsed = await w.account("Lapsed");
    const lostContract = await w.contract(lost.id, {
      endDate: d("2026-11-10"),
      renewalDate: d("2026-11-10"),
    });
    await w.contract(lapsed.id, { endDate: d("2026-11-10"), renewalDate: d("2026-11-10") });
    await syncRenewals(w.actor, [lost.id, lapsed.id], NOW);
    await w.db.contract.update({ where: { id: lostContract.id }, data: { status: "CANCELLED" } });
    const out = await syncRenewals(w.actor, [lost.id, lapsed.id], "2026-11-12");
    expect(out).toMatchObject({ churned: 1, renewed: 0 });
    const outcome = await w.db.renewalOutcome.findFirstOrThrow({ where: { accountId: lost.id } });
    expect(outcome).toMatchObject({ result: "CHURNED", outcomeArrMinor: 0n });
    expect(await w.db.renewalOutcome.count({ where: { accountId: lapsed.id } })).toBe(0);
    expect((await w.db.renewal.findFirstOrThrow({ where: { accountId: lapsed.id } })).stage).toBe(
      "UPCOMING",
    );
  });

  it("opens no signals and is scoped to its own workspace", async () => {
    const a = await world("SyncScopeA");
    const b = await world("SyncScopeB");
    const acct = await b.account("B's");
    await b.contract(acct.id);
    const signalsBefore = await a.db.signal.count();
    // A's context asked about B's account id finds nothing.
    expect(await syncRenewals(a.actor, [acct.id], NOW)).toMatchObject({ created: 0 });
    expect(await b.db.renewal.count()).toBe(0);
    await syncRenewals(b.actor, [acct.id], NOW);
    expect(await b.db.signal.count()).toBe(0);
    expect(await a.db.signal.count()).toBe(signalsBefore);
  });
});
