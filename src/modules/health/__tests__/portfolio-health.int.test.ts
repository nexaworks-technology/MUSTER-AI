import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin, createTestUser } from "@/test/fixtures";
import { portfolioHealth } from "../service";

/**
 * FIX-2026-11-11-ASK2 item 1: "which accounts are at risk and why" is answered from ONE deterministic
 * read: band counts plus the accounts in the bad bands, each with its health reasons and the ids of
 * the records behind them. This is the same data the Health page shows (the displayed snapshot under
 * the active model), limited to the member's book.
 */
type Level = "AT_RISK" | "WATCH" | "HEALTHY";

async function modelFor(db: ScopedDb, ws: string) {
  return (
    (await db.healthModel.findFirst({ where: { status: "ACTIVE" } })) ??
    (await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    }))
  );
}

/** An account with a current snapshot and the given reasons (at least one: it is the risk reason). */
async function scored(
  db: ScopedDb,
  ws: string,
  name: string,
  level: Level,
  overall: number,
  reasons: Array<{ message: string; impact: number }>,
  extra: { ownerMembershipId?: string; lifecycleStage?: "LOST"; arrMinor?: bigint } = {},
) {
  const model = await modelFor(db, ws);
  const a = await db.account.create({
    data: {
      workspaceId: ws,
      name,
      tier: "MID_TOUCH",
      arrMinor: extra.arrMinor ?? null,
      arrCurrency: extra.arrMinor ? "USD" : null,
      ownerMembershipId: extra.ownerMembershipId ?? null,
      ...(extra.lifecycleStage ? { lifecycleStage: extra.lifecycleStage } : {}),
    },
  });
  const snapshotId = randomUUID();
  const reasonIds = reasons.map(() => randomUUID());
  await db.$tenantTransaction(async (tx) => {
    await tx.healthScoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId: ws,
        accountId: a.id,
        healthModelId: model.id,
        asOf: new Date("2026-11-10"),
        overall,
        adoption: overall,
        riskLevel: level,
        riskLevelExcludingPulse: level,
        riskReasonId: level === "AT_RISK" ? reasonIds[0]! : null,
        effectiveWeights: {},
        inputsHash: snapshotId,
      },
    });
    for (const [i, r] of reasons.entries())
      await tx.healthReason.create({
        data: {
          id: reasonIds[i]!,
          workspaceId: ws,
          snapshotId,
          pillar: "ADOPTION",
          component: `c${i}`,
          kind: "EVIDENCE",
          direction: "DOWN",
          impact: r.impact,
          input: "i",
          message: r.message,
          sortOrder: i,
          sources: [{ sourceType: "Account", sourceId: a.id }],
        },
      });
    await tx.account.update({ where: { id: a.id }, data: { currentHealthSnapshotId: snapshotId } });
  });
  return { accountId: a.id, snapshotId, reasonIds, name };
}

async function world(label: string) {
  const { actor, workspace } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = workspace.id;
  const zenith = await scored(db, ws, "Zenith Foods", "AT_RISK", 31.5, [
    { message: "Weekday active users fell from 41 to 17 (−59%)", impact: -22 },
    { message: "3 high-priority tickets are open", impact: -9 },
    { message: "No champion contact reached in 90 days", impact: -4 },
    { message: "A fourth reason that must be cut by the per-account cap", impact: -1 },
  ]);
  const brightline = await scored(db, ws, "Brightline Co", "AT_RISK", 38, [
    { message: "Invoices are 45 days overdue", impact: -15 },
  ]);
  const quartz = await scored(db, ws, "Quartz Ltd", "WATCH", 52, [
    { message: "Feature adoption is flat at 12%", impact: -6 },
  ]);
  const calm = await scored(db, ws, "Calm Inc", "HEALTHY", 91, [
    { message: "Usage is above its normal", impact: 3 },
  ]);
  // Never listed: a lost account with an at-risk snapshot, and an archived one.
  await scored(db, ws, "Gone Co", "AT_RISK", 10, [{ message: "Cancelled", impact: -30 }], {
    lifecycleStage: "LOST",
  });
  const archived = await scored(db, ws, "Archived Co", "AT_RISK", 12, [
    { message: "Old", impact: -20 },
  ]);
  await db.account.update({ where: { id: archived.accountId }, data: { archivedAt: new Date() } });
  // An unscored account counts as "not scored", in no band.
  await db.account.create({ data: { workspaceId: ws, name: "Fresh Co", tier: "MID_TOUCH" } });
  return { actor, db, ws, zenith, brightline, quartz, calm };
}

describe("portfolioHealth: bands, the accounts in them, and why", () => {
  it("returns the band counts and the At Risk then Watch accounts, each with its reasons", async () => {
    const w = await world("PortfolioA");
    const p = await portfolioHealth(w.actor);
    expect(p.counts).toEqual({ AT_RISK: 2, WATCH: 1, HEALTHY: 1, INSUFFICIENT_DATA: 0 });
    expect(p.totalInBands).toBe(3);
    expect(p.asOf).toBe("2026-11-10");
    // At Risk first (lowest score first), then Watch. Lost, archived and unscored are absent.
    expect(p.accounts.map((a) => [a.name, a.band, a.overall])).toEqual([
      ["Zenith Foods", "AT_RISK", 31.5],
      ["Brightline Co", "AT_RISK", 38],
      ["Quartz Ltd", "WATCH", 52],
    ]);
    const zenith = p.accounts[0]!;
    expect(zenith.accountId).toBe(w.zenith.accountId);
    expect(zenith.snapshotId).toBe(w.zenith.snapshotId);
    // Most negative first, capped at three per account.
    expect(zenith.reasons.map((r) => r.message)).toEqual([
      "Weekday active users fell from 41 to 17 (−59%)",
      "3 high-priority tickets are open",
      "No champion contact reached in 90 days",
    ]);
    // The reasons carry the real HealthReason ids, so every one is a record that exists.
    expect(zenith.reasons.map((r) => r.id)).toEqual(w.zenith.reasonIds.slice(0, 3));
  });

  it("filters to one band, and says how many were left out when it cuts the list", async () => {
    const w = await world("PortfolioB");
    const atRisk = await portfolioHealth(w.actor, { bands: ["AT_RISK"] });
    expect(atRisk.accounts.map((a) => a.name)).toEqual(["Zenith Foods", "Brightline Co"]);
    expect(atRisk.counts.WATCH).toBe(1); // counts always describe the whole book
    const cut = await portfolioHealth(w.actor, { limit: 1 });
    expect(cut.accounts.map((a) => a.name)).toEqual(["Zenith Foods"]);
    expect(cut.totalInBands).toBe(3);
  });

  it("is limited to the member's book and never reads another workspace", async () => {
    const w = await world("PortfolioC");
    const csmUser = await createTestUser("PortfolioCsm");
    const csm = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${w.ws}, true)`;
      return tx.membership.create({
        data: {
          workspaceId: w.ws,
          userId: csmUser.id,
          role: "CSM",
          bookScope: "OWN",
          canViewRevenue: false,
        },
      });
    });
    const csmActor = {
      workspaceId: w.ws,
      userId: csmUser.id,
      membershipId: csm.id,
      role: "CSM" as const,
      canViewRevenue: false,
      bookScope: "OWN" as const,
    };
    // Give the CSM exactly one at-risk account of their own.
    const mine = await scored(
      w.db,
      w.ws,
      "Mine At Risk",
      "AT_RISK",
      20,
      [{ message: "Usage collapsed", impact: -25 }],
      { ownerMembershipId: csm.id },
    );
    const own = await portfolioHealth(csmActor);
    expect(own.accounts.map((a) => a.name)).toEqual(["Mine At Risk"]);
    expect(own.counts).toEqual({ AT_RISK: 1, WATCH: 0, HEALTHY: 0, INSUFFICIENT_DATA: 0 });
    expect(own.accounts[0]!.accountId).toBe(mine.accountId);

    const other = await world("PortfolioOther");
    const theirs = await portfolioHealth(other.actor);
    expect(theirs.accounts.map((a) => a.accountId)).not.toContain(w.zenith.accountId);
  });

  it("shows ARR only to a member with revenue access", async () => {
    const { actor, workspace } = await createTestAdmin("PortfolioArr");
    const db = scopedDb(actor);
    await scored(
      db,
      workspace.id,
      "Money Co",
      "AT_RISK",
      30,
      [{ message: "Late payments", impact: -20 }],
      {
        arrMinor: 12_000_000n,
      },
    );
    const withMoney = await portfolioHealth({ ...actor, canViewRevenue: true });
    expect(withMoney.accounts[0]!.arrMinor).toBe(12_000_000n);
    const without = await portfolioHealth({ ...actor, canViewRevenue: false });
    expect(without.accounts[0]!.arrMinor).toBeNull();
  });

  it("an empty portfolio is reported as having no scored accounts, not as all healthy", async () => {
    const { actor } = await createTestAdmin("PortfolioEmpty");
    const p = await portfolioHealth(actor);
    expect(p.accounts).toEqual([]);
    expect(p.totalInBands).toBe(0);
    expect(p.asOf).toBeNull();
  });
});
