import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateLongCheckpoints, type LongCheckpoint } from "../service";

/**
 * M11 S2: the 30/90-day checkpoints on the database. Stored once on workspace business dates
 * (evaluated a 7-day grace after the checkpoint date), frozen by the `outcome_checkpoint_frozen`
 * trigger, citing both sides (the flag + health at the flag; the outcome evidence), the alarm class
 * frozen at d90, back-test snapshots never used (D-158), one audit row per stored checkpoint, and
 * scoped to the workspace.
 */
const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
const at = (daysAgo: number) => new Date(+NOW - daysAgo * DAY);
const dateAgo = (daysAgo: number) => new Date(at(daysAgo).toISOString().slice(0, 10));
let db: ScopedDb;
let ws: string;
let ctx: { workspaceId: string; timezone: string };
let modelId: string;

beforeAll(async () => {
  const { actor } = await createTestAdmin("OutLong");
  db = scopedDb(actor);
  ws = actor.workspaceId;
  ctx = { workspaceId: ws, timezone: "UTC" };
  const model =
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
    }));
  modelId = model.id;
});

async function flagged(
  daysAgo: number,
  opts: { actedDaysAgo?: number; status?: "OPEN" | "FALSE_ALARM" } = {},
) {
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `L ${randomUUID().slice(0, 6)}`,
      tier: "MID_TOUCH",
      timezone: "UTC",
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      title: "t",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: account.id }],
      values: {},
      params: {},
      dedupeKey: `d:${account.id}`,
      firstSeenAt: at(daysAgo),
      lastSeenAt: at(daysAgo),
    },
  });
  if (opts.status === "FALSE_ALARM")
    await db.signal.update({
      where: { id: signal.id },
      data: {
        status: "FALSE_ALARM",
        falseAlarmReason: "seasonal dip",
        markedFalseAt: at(daysAgo - 1),
      },
    });
  const outcome = await db.outcomeRecord.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      signalId: signal.id,
      flagType: "RISK",
      flaggedAt: at(daysAgo),
      arrAtFlagMinor: 10_000_000n,
      arrCurrency: "USD",
      actionTaken: opts.actedDaysAgo !== undefined ? "ACTED" : "PENDING",
      firstActionAt: opts.actedDaysAgo !== undefined ? at(opts.actedDaysAgo) : null,
    },
  });
  return { account, signal, outcome };
}

async function snap(
  accountId: string,
  asOf: Date,
  riskLevel: "AT_RISK" | "WATCH" | "HEALTHY",
  isBacktest = false,
) {
  const id = randomUUID();
  await db.$tenantTransaction(async (tx) => {
    const reasonId = randomUUID();
    await tx.healthScoreSnapshot.create({
      data: {
        id,
        workspaceId: ws,
        accountId,
        healthModelId: modelId,
        asOf,
        overall: riskLevel === "AT_RISK" ? 30 : riskLevel === "WATCH" ? 55 : 80,
        adoption: 50,
        riskLevel,
        riskLevelExcludingPulse: riskLevel,
        effectiveWeights: {},
        inputsHash: id,
        isBacktest,
        riskReasonId: riskLevel === "AT_RISK" ? reasonId : null,
      },
    });
    await tx.healthReason.create({
      data: {
        id: reasonId,
        workspaceId: ws,
        snapshotId: id,
        pillar: "ADOPTION",
        component: "c",
        kind: "EVIDENCE",
        direction: "DOWN",
        impact: -5,
        input: "i",
        message: "m",
        sources: [{ sourceType: "Account", sourceId: accountId }],
      },
    });
  });
  return id;
}

async function churnEvent(accountId: string, daysAgo: number) {
  return db.revenueEvent.create({
    data: {
      workspaceId: ws,
      accountId,
      type: "CHURN",
      deltaArrMinor: -10_000_000n,
      currency: "USD",
      effectiveDate: dateAgo(daysAgo),
      sourceType: "Account",
      sourceId: accountId,
    },
  });
}

const read = (id: string) => db.outcomeRecord.findUniqueOrThrow({ where: { id } });

describe("evaluateLongCheckpoints", () => {
  it("is not due before the 7-day grace after the business-date checkpoint", async () => {
    const { outcome } = await flagged(36);
    await evaluateLongCheckpoints(ctx, () => NOW);
    expect((await read(outcome.id)).d30Outcome).toBeNull();
  });

  it("stores d30 and d90 once, citing the flag, the health at the flag and the outcome evidence; frozen at d90", async () => {
    const { account, signal, outcome } = await flagged(100, { actedDaysAgo: 98 });
    const s0 = await snap(account.id, dateAgo(101), "WATCH");
    // A back-test row claiming HEALTHY at the flag must never be read (D-158).
    await snap(account.id, dateAgo(100), "HEALTHY", true);
    const churn = await churnEvent(account.id, 20);

    const res = await evaluateLongCheckpoints(ctx, () => NOW);
    expect(res.evaluated).toBeGreaterThanOrEqual(2);
    const r = await read(outcome.id);
    const d30 = r.d30Outcome as unknown as LongCheckpoint;
    const d90 = r.d90Outcome as unknown as LongCheckpoint;
    expect(d30.status).toBe("NO_CHANGE");
    expect(d30.evidence).toEqual([]);
    expect(d30.actionTaken).toBe("ACTED");
    expect(d90.status).toBe("CHURNED");
    expect(d90.evidence).toEqual([{ sourceType: "RevenueEvent", sourceId: churn.id }]);
    expect(d90.prediction).toMatchObject({
      signalId: signal.id,
      flagType: "RISK",
      healthAtFlag: { snapshotId: s0, riskLevel: "WATCH" },
    });
    expect(d90.attributed).toBe(true);
    expect(r.isTrueAlarm).toBe(true);

    const audits = await db.auditLog.findMany({
      where: { targetId: outcome.id, action: "outcome.checkpoint" },
    });
    expect(audits).toHaveLength(2);

    // Idempotent: nothing left to evaluate for this record.
    await evaluateLongCheckpoints(ctx, () => new Date(+NOW + 5 * DAY));
    expect(
      await db.auditLog.count({ where: { targetId: outcome.id, action: "outcome.checkpoint" } }),
    ).toBe(2);
  });

  it("the database refuses a rewrite of a stored checkpoint (frozen comparison)", async () => {
    const { outcome } = await flagged(45);
    await evaluateLongCheckpoints(ctx, () => NOW);
    const r = await read(outcome.id);
    expect(r.d30Outcome).not.toBeNull();
    await expect(
      db.outcomeRecord.update({
        where: { id: outcome.id },
        data: { d30Outcome: { status: "RENEWED" } },
      }),
    ).rejects.toThrow();
  });

  it("marked FALSE_ALARM with no adverse outcome → false alarm at d90", async () => {
    const { outcome } = await flagged(100, { status: "FALSE_ALARM" });
    await evaluateLongCheckpoints(ctx, () => NOW);
    const r = await read(outcome.id);
    expect((r.d90Outcome as unknown as LongCheckpoint).status).toBe("NO_CHANGE");
    expect(r.isTrueAlarm).toBe(false);
  });

  it("undetermined alarms stay null", async () => {
    const { outcome } = await flagged(100);
    await evaluateLongCheckpoints(ctx, () => NOW);
    expect((await read(outcome.id)).isTrueAlarm).toBeNull();
  });

  it("a scoped run (demo/backfill) evaluates only the named accounts", async () => {
    const inScope = await flagged(100);
    const outOfScope = await flagged(100);
    await evaluateLongCheckpoints(ctx, () => NOW, { accountIds: [inScope.account.id] });
    expect((await read(inScope.outcome.id)).d90Outcome).not.toBeNull();
    expect((await read(outOfScope.outcome.id)).d30Outcome).toBeNull();
    expect((await read(outOfScope.outcome.id)).d90Outcome).toBeNull();
  });

  it("never evaluates another workspace's records", async () => {
    const { actor: other } = await createTestAdmin("OutLongB");
    const odb = scopedDb(other);
    const account = await odb.account.create({
      data: { workspaceId: other.workspaceId, name: "B", tier: "MID_TOUCH", timezone: "UTC" },
    });
    const foreign = await odb.outcomeRecord.create({
      data: {
        workspaceId: other.workspaceId,
        accountId: account.id,
        flagType: "RISK",
        flaggedAt: at(100),
      },
    });
    await evaluateLongCheckpoints(ctx, () => NOW);
    const row = await odb.outcomeRecord.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.d30Outcome).toBeNull();
    expect(row.d90Outcome).toBeNull();
  });
});
