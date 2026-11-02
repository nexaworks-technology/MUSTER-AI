import { randomUUID as createId } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * M3 rule 2 at the database level: a score carries its proof or it cannot be stored. These
 * inserts bypass the application writer on purpose, to prove the database itself refuses.
 */
let db: ReturnType<typeof scopedDb>;
let ws: string;
let accountId: string;
let modelId: string;
let day = 0;

const nextDay = () => new Date(Date.UTC(2026, 0, 1 + day++));

beforeAll(async () => {
  const { actor } = await createTestAdmin("SnapshotDb");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "Proof", tier: "MID_TOUCH" } })
  ).id;
  modelId = (
    await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    })
  ).id;
});

type Tx = Prisma.TransactionClient;
const snapshot = (
  over: Partial<Prisma.HealthScoreSnapshotUncheckedCreateInput> = {},
): Prisma.HealthScoreSnapshotUncheckedCreateInput => ({
  id: createId(),
  workspaceId: ws,
  accountId,
  healthModelId: modelId,
  asOf: nextDay(),
  overall: 30,
  adoption: 20,
  support: 40,
  riskLevel: "AT_RISK",
  riskLevelExcludingPulse: "AT_RISK",
  effectiveWeights: {},
  inputsHash: "h",
  ...over,
});
const reason = (
  snapshotId: string,
  over: Partial<Prisma.HealthReasonUncheckedCreateInput> = {},
): Prisma.HealthReasonUncheckedCreateInput => ({
  workspaceId: ws,
  snapshotId,
  pillar: "ADOPTION",
  component: "active_vs_own",
  kind: "EVIDENCE",
  direction: "DOWN",
  impact: -20,
  score: 20,
  message: "Typical weekday active users fell from 41 to 17.",
  input: "active_users_5d",
  sources: [{ sourceType: "UsageDaily", accountId: "x", from: "2026-10-01", to: "2026-10-31" }],
  ...over,
});

/** Writes a snapshot plus reasons in one transaction, as the real writer does. */
const write = (fn: (tx: Tx) => Promise<unknown>) => db.$tenantTransaction(fn);

/** A complete, valid At Risk snapshot: Adoption and Support each have evidence. */
async function validWrite(
  tx: Tx,
  over: Partial<Prisma.HealthScoreSnapshotUncheckedCreateInput> = {},
) {
  const riskId = createId();
  const s = snapshot({ riskReasonId: riskId, ...over });
  await tx.healthScoreSnapshot.create({ data: s });
  await tx.healthReason.create({ data: reason(s.id!, { id: riskId }) });
  await tx.healthReason.create({
    data: reason(s.id!, { pillar: "SUPPORT", component: "open_high", impact: -10 }),
  });
  return s.id!;
}

describe("the database refuses a score without proof (M3 rule 2)", () => {
  it("accepts an At Risk snapshot whose risk reason is its own evidence", async () => {
    const id = await write((tx) => validWrite(tx));
    expect(await db.healthReason.count({ where: { snapshotId: id as string } })).toBe(2);
  });

  it("rejects At Risk with no risk reason", async () => {
    await expect(
      write(async (tx) => {
        const s = snapshot();
        await tx.healthScoreSnapshot.create({ data: s });
        await tx.healthReason.create({ data: reason(s.id!) });
        await tx.healthReason.create({ data: reason(s.id!, { pillar: "SUPPORT" }) });
      }),
    ).rejects.toThrow(/at_risk_has_reason/);
  });

  it("rejects At Risk whose reasons array is empty (the risk reason id points nowhere)", async () => {
    await expect(
      write((tx) =>
        tx.healthScoreSnapshot.create({ data: snapshot({ riskReasonId: createId() }) }),
      ),
    ).rejects.toThrow();
    expect(
      await db.healthScoreSnapshot.count({
        where: { accountId, riskReasonId: { not: null }, reasons: { none: {} } },
      }),
    ).toBe(0);
  });

  it("rejects a risk reason borrowed from another snapshot", async () => {
    const otherId = await write((tx) => validWrite(tx));
    const borrowed = await db.healthReason.findFirstOrThrow({
      where: { snapshotId: otherId as string },
    });
    await expect(
      write(async (tx) => {
        const s = snapshot({ riskReasonId: borrowed.id });
        await tx.healthScoreSnapshot.create({ data: s });
        await tx.healthReason.create({ data: reason(s.id!) });
        await tx.healthReason.create({ data: reason(s.id!, { pillar: "SUPPORT" }) });
      }),
    ).rejects.toThrow();
  });

  it("rejects an evidence reason with no source", async () => {
    await expect(
      write(async (tx) => {
        const riskId = createId();
        const s = snapshot({ riskReasonId: riskId });
        await tx.healthScoreSnapshot.create({ data: s });
        await tx.healthReason.create({ data: reason(s.id!, { id: riskId, sources: [] }) });
      }),
    ).rejects.toThrow(/evidence_has_sources/);
  });

  it("rejects a pillar score with no evidence reason (a missing-data note is not proof)", async () => {
    await expect(
      write(async (tx) => {
        const riskId = createId();
        const s = snapshot({ riskReasonId: riskId });
        await tx.healthScoreSnapshot.create({ data: s });
        await tx.healthReason.create({ data: reason(s.id!, { id: riskId }) });
        await tx.healthReason.create({
          data: reason(s.id!, { pillar: "SUPPORT", kind: "MISSING_DATA", sources: [] }),
        });
      }),
    ).rejects.toThrow(/SUPPORT score but no evidence reason/);
  });

  it("rejects a missing-data note used as the risk reason", async () => {
    await expect(
      write(async (tx) => {
        const riskId = createId();
        const s = snapshot({ riskReasonId: riskId, support: null });
        await tx.healthScoreSnapshot.create({ data: s });
        await tx.healthReason.create({ data: reason(s.id!) });
        await tx.healthReason.create({
          data: reason(s.id!, { id: riskId, kind: "MISSING_DATA", sources: [] }),
        });
      }),
    ).rejects.toThrow(/not evidence/);
  });

  it("keeps history immutable: no edits to snapshots or reasons, no deleting the only proof", async () => {
    const id = (await write((tx) => validWrite(tx))) as string;
    await expect(
      db.healthScoreSnapshot.update({ where: { id }, data: { overall: 90 } }),
    ).rejects.toThrow(/immutable/);
    const support = await db.healthReason.findFirstOrThrow({
      where: { snapshotId: id, pillar: "SUPPORT" },
    });
    await expect(
      db.healthReason.update({ where: { id: support.id }, data: { message: "edited" } }),
    ).rejects.toThrow(/immutable/);
    await expect(db.healthReason.delete({ where: { id: support.id } })).rejects.toThrow(
      /no evidence reason/,
    );
  });
});

describe("health model versions (M3 rule 5)", () => {
  it("allows only one ACTIVE model per workspace", async () => {
    await expect(
      db.healthModel.create({
        data: {
          workspaceId: ws,
          version: 2,
          status: "ACTIVE",
          proposedBy: "HUMAN",
          pillarWeights: {},
          componentConfig: {},
          thresholds: {},
        },
      }),
    ).rejects.toThrow();
  });

  it("freezes a model once it leaves DRAFT, and never revives a retired one", async () => {
    await expect(
      db.healthModel.update({ where: { id: modelId }, data: { pillarWeights: { ADOPTION: 1 } } }),
    ).rejects.toThrow(/create a new version/);
    const draft = await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 3,
        proposedBy: "HUMAN",
        pillarWeights: {},
        componentConfig: {},
        thresholds: {},
      },
    });
    await db.healthModel.update({
      where: { id: draft.id },
      data: { pillarWeights: { ADOPTION: 1 } },
    });
    await db.healthModel.update({ where: { id: draft.id }, data: { status: "RETIRED" } });
    await expect(
      db.healthModel.update({ where: { id: draft.id }, data: { status: "ACTIVE" } }),
    ).rejects.toThrow(/reactivated/);
  });
});
