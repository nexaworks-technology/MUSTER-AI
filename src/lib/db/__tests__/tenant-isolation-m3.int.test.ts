import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for the M3 models (M3 rule 11). Kept in its own file: M3 may not edit pre-M3 test files
 * (founder decision 3). Each model gets the same attacks as M1/M2: read, update, delete and raw
 * SQL across workspaces, and composite FKs that refuse cross-workspace references.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const workspaceId = actor.workspaceId;
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId, name: `${label} account`, tier: "MID_TOUCH" },
  });
  const model = await db.healthModel.create({
    data: {
      workspaceId,
      version: 1,
      status: "ACTIVE",
      proposedBy: "SYSTEM_DEFAULT",
      pillarWeights: {},
      componentConfig: {},
      thresholds: { healthyMin: 70, watchMin: 45 },
    },
  });
  const pulse = await db.csmPulse.create({
    data: {
      workspaceId,
      accountId: account.id,
      membershipId: actor.membershipId,
      value: "WORRIED",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const snapshotId = randomUUID();
  await db.$tenantTransaction(async (tx) => {
    await tx.healthScoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        accountId: account.id,
        healthModelId: model.id,
        asOf: new Date("2026-11-02"),
        overall: 80,
        adoption: 80,
        support: 80,
        riskLevel: "HEALTHY",
        riskLevelExcludingPulse: "HEALTHY",
        effectiveWeights: {},
        inputsHash: "h",
      },
    });
    for (const pillar of ["ADOPTION", "SUPPORT"] as const)
      await tx.healthReason.create({
        data: {
          workspaceId,
          snapshotId,
          pillar,
          component: "c",
          kind: "EVIDENCE",
          direction: "UP",
          impact: -10,
          message: "m",
          input: "i",
          sources: [{ sourceType: "Account", sourceId: account.id }],
        },
      });
  });
  const snapshot = await db.healthScoreSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
  const reason = await db.healthReason.findFirstOrThrow({ where: { snapshotId } });
  const baseline = await db.usageBaseline.create({
    data: {
      workspaceId,
      accountId: account.id,
      metric: "active_users_5d",
      windowEnd: new Date("2026-11-02"),
      historyDays: 90,
    },
  });
  return { actor, workspaceId, db, account, model, pulse, snapshot, reason, baseline };
}

beforeAll(async () => {
  A = await setup("TenantM3A");
  B = await setup("TenantM3B");
});

const CASES = [
  { model: "HealthModel", delegate: "healthModel", row: (s: Side) => s.model },
  { model: "HealthScoreSnapshot", delegate: "healthScoreSnapshot", row: (s: Side) => s.snapshot },
  { model: "HealthReason", delegate: "healthReason", row: (s: Side) => s.reason },
  { model: "CsmPulse", delegate: "csmPulse", row: (s: Side) => s.pulse },
  { model: "UsageBaseline", delegate: "usageBaseline", row: (s: Side) => s.baseline },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M3 health models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update or delete B's row`, async () => {
      // Delegates differ per model; only the shared id/workspaceId surface is used here.
      const d = A.db[c.delegate] as unknown as {
        findMany: () => Promise<Array<{ workspaceId: string }>>;
        findUnique: (a: { where: { id: string } }) => Promise<unknown>;
        updateMany: (a: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>;
        deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
      };
      const bId = c.row(B).id;
      expect((await d.findMany()).every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      expect((await d.updateMany({ where: { id: bId }, data: {} })).count).toBe(0);
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("a Pulse cannot point at another workspace's account or member (composite FK)", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    await expect(
      A.db.csmPulse.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: B.account.id,
          membershipId: A.actor.membershipId,
          value: "FINE",
          expiresAt,
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.csmPulse.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          membershipId: B.actor.membershipId,
          value: "FINE",
          expiresAt,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a snapshot cannot use another workspace's model or account (composite FK)", async () => {
    const base = {
      workspaceId: A.workspaceId,
      asOf: new Date("2026-10-01"),
      riskLevel: "INSUFFICIENT_DATA" as const,
      riskLevelExcludingPulse: "INSUFFICIENT_DATA" as const,
      effectiveWeights: {},
      inputsHash: "h",
    };
    await expect(
      A.db.healthScoreSnapshot.create({
        data: { ...base, accountId: A.account.id, healthModelId: B.model.id },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.healthScoreSnapshot.create({
        data: { ...base, accountId: B.account.id, healthModelId: A.model.id },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("an account's current snapshot cannot be another workspace's (composite FK)", async () => {
    await expect(
      A.db.account.update({
        where: { id: A.account.id },
        data: { currentHealthSnapshotId: B.snapshot.id },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a baseline cannot be written for another workspace's account (composite FK)", async () => {
    await expect(
      A.db.usageBaseline.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: B.account.id,
          metric: "m",
          windowEnd: new Date("2026-10-01"),
          historyDays: 0,
        },
      }),
    ).rejects.toSatisfy(fk);
  });
});
