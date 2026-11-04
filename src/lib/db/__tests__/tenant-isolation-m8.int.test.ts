import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for the M8 models (Play, PlayVersion, PlayRun, PlayStepRun).
 * Strengthened attack pattern: real-field update/delete on another workspace's rows change 0,
 * own-row controls change 1.
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

  const signal = await db.signal.create({
    data: {
      workspaceId,
      accountId: account.id,
      ruleKey: "health_band_drop",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      status: "OPEN",
      title: "Health dropped",
      explanation: "Test",
      evidence: [{ sourceType: "HealthScoreSnapshot", sourceId: "s1", date: "2026-11-01" }],
      values: {},
      params: {},
      dedupeKey: `health_band_drop:${account.id}`,
      episode: 1,
      firstSeenAt: new Date("2026-11-01"),
      lastSeenAt: new Date("2026-11-01"),
    },
  });

  const play = await db.play.create({
    data: {
      workspaceId,
      key: `play-${label.toLowerCase()}`,
      name: `${label} Play`,
      category: "risk",
      status: "DRAFT",
    },
  });

  const version = await db.playVersion.create({
    data: {
      workspaceId,
      playId: play.id,
      version: 1,
      definition: {
        trigger: { type: "signal", ruleKey: "health_band_drop" },
        steps: [{ key: "s1", handler: "notify" }],
      },
    },
  });

  const run = await db.playRun.create({
    data: {
      workspaceId,
      playId: play.id,
      playVersionId: version.id,
      accountId: account.id,
      triggerRef: `signal:${signal.id}`,
      signalId: signal.id,
      status: "RUNNING",
    },
  });

  const stepRun = await db.playStepRun.create({
    data: {
      workspaceId,
      playRunId: run.id,
      stepKey: "s1",
      handler: "notify",
      status: "PENDING",
    },
  });

  return { actor, workspaceId, db, account, signal, play, version, run, stepRun };
}

beforeAll(async () => {
  A = await setup("TenantM8A");
  B = await setup("TenantM8B");
});

type Delegate = {
  findMany: () => Promise<Array<{ workspaceId: string }>>;
  findUnique: (a: { where: { id: string } }) => Promise<unknown>;
  updateMany: (a: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
};

const CASES = [
  {
    model: "Play",
    delegate: "play",
    row: (s: Side) => s.play,
    write: () => ({ name: "attack-control" }),
  },
  {
    model: "PlayVersion",
    delegate: "playVersion",
    row: (s: Side) => s.version,
    write: () => ({ safetyCheck: { checked: true } }),
  },
  {
    model: "PlayRun",
    delegate: "playRun",
    row: (s: Side) => s.run,
    write: () => ({ exitReason: "attack-control" }),
  },
  {
    model: "PlayStepRun",
    delegate: "playStepRun",
    row: (s: Side) => s.stepRun,
    write: () => ({ result: { note: "attack-control" } }),
  },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M8 models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update (real field) or delete B's row; A's own write lands`, async () => {
      const d = A.db[c.delegate] as unknown as Delegate;
      const bId = c.row(B).id;
      const rows = await d.findMany();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();

      // Attack: update B's row using A's tenant context -> 0 rows changed
      expect((await d.updateMany({ where: { id: bId }, data: c.write() })).count).toBe(0);

      // Control: update A's own row -> 1 row changed
      expect((await d.updateMany({ where: { id: c.row(A).id }, data: c.write() })).count).toBe(1);

      // Attack: delete B's row using A's tenant context -> 0 rows deleted
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);

      // Verify B's row still exists in B
      expect(
        await (B.db[c.delegate] as unknown as Delegate).findUnique({ where: { id: bId } }),
      ).not.toBeNull();
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("PlayVersion cannot point to a Play in another workspace", async () => {
    await expect(
      A.db.playVersion.create({
        data: {
          workspaceId: A.workspaceId,
          playId: B.play.id,
          version: 99,
          definition: {},
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("PlayRun cannot point to account, play, version, or signal from another workspace", async () => {
    // Other account
    await expect(
      A.db.playRun.create({
        data: {
          workspaceId: A.workspaceId,
          playId: A.play.id,
          playVersionId: A.version.id,
          accountId: B.account.id,
          triggerRef: "test-ref",
        },
      }),
    ).rejects.toSatisfy(fk);

    // Other play
    await expect(
      A.db.playRun.create({
        data: {
          workspaceId: A.workspaceId,
          playId: B.play.id,
          playVersionId: A.version.id,
          accountId: A.account.id,
          triggerRef: "test-ref",
        },
      }),
    ).rejects.toSatisfy(fk);

    // Other version
    await expect(
      A.db.playRun.create({
        data: {
          workspaceId: A.workspaceId,
          playId: A.play.id,
          playVersionId: B.version.id,
          accountId: A.account.id,
          triggerRef: "test-ref",
        },
      }),
    ).rejects.toSatisfy(fk);

    // Other signal
    await expect(
      A.db.playRun.create({
        data: {
          workspaceId: A.workspaceId,
          playId: A.play.id,
          playVersionId: A.version.id,
          accountId: A.account.id,
          triggerRef: "test-ref",
          signalId: B.signal.id,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("PlayStepRun cannot point to a PlayRun from another workspace", async () => {
    await expect(
      A.db.playStepRun.create({
        data: {
          workspaceId: A.workspaceId,
          playRunId: B.run.id,
          stepKey: "s1",
          handler: "notify",
        },
      }),
    ).rejects.toSatisfy(fk);
  });
});
