import { randomUUID as createId } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { aggregate, type ComponentResults } from "../engine/aggregate";
import { DEFAULT_MODEL, PILLARS } from "../engine/model";
import { writeSnapshot, type SnapshotDraft } from "../snapshots";

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

describe("health.writeSnapshot(): the only insert path (M3 rule 2, condition B)", () => {
  const ev = (
    pillar: string,
    score: number,
    sources = [{ sourceType: "Test", sourceId: pillar }],
  ) => ({
    score,
    reason: {
      component: "main",
      kind: "EVIDENCE" as const,
      input: "x",
      message: `${pillar} ${score}`,
      sources,
    },
  });
  const ONE = {
    ...DEFAULT_MODEL,
    componentConfig: Object.fromEntries(PILLARS.map((p) => [p, { main: { weight: 1 } }])),
  };
  const agg = (adoption: number) =>
    aggregate(
      Object.fromEntries(
        PILLARS.map((p) => [
          p,
          {
            main:
              p === "ADOPTION"
                ? ev(p, adoption)
                : p === "SUPPORT"
                  ? ev(p, 50)
                  : {
                      score: null,
                      reason: {
                        component: "main",
                        kind: "MISSING_DATA" as const,
                        input: "x",
                        message: "none",
                        sources: [],
                      },
                    },
          },
        ]),
      ) as unknown as ComponentResults,
      ONE,
      "MID_TOUCH",
    );
  const draft = (
    asOf: string,
    a = agg(10),
    hash = "h1",
    healthModelId = modelId,
  ): SnapshotDraft => ({
    accountId,
    healthModelId,
    asOf,
    isBacktest: false,
    inputsHash: hash,
    score: a,
  });

  it("refuses (Zod) a pillar score with no evidence reason, before touching the database", async () => {
    const a = agg(10);
    const bad = { ...a, reasons: a.reasons.filter((r) => r.pillar !== "SUPPORT") };
    await expect(writeSnapshot(db, ws, { ...draft("2026-03-01"), score: bad })).rejects.toThrow(
      /SUPPORT has a score but no evidence reason/,
    );
    expect(await db.healthScoreSnapshot.count({ where: { asOf: new Date("2026-03-01") } })).toBe(0);
  });

  it("refuses (Zod) an evidence reason with no source", async () => {
    const a = agg(10);
    const bad = {
      ...a,
      reasons: a.reasons.map((r) => (r.pillar === "ADOPTION" ? { ...r, sources: [] } : r)),
    };
    await expect(writeSnapshot(db, ws, { ...draft("2026-03-02"), score: bad })).rejects.toThrow(
      /needs at least one source/,
    );
  });

  it("writes an At Risk snapshot whose risk reason is its own evidence, and points the account at it", async () => {
    const before = await db.account.findUniqueOrThrow({ where: { id: accountId } });
    const r = await writeSnapshot(db, ws, draft("2026-03-03"), { makeCurrent: true });
    expect(r.outcome).toBe("CREATED");
    const s = await db.healthScoreSnapshot.findUniqueOrThrow({
      where: { id: r.id },
      include: { reasons: true, riskReason: true },
    });
    expect(s.riskLevel).toBe("AT_RISK");
    expect(s.riskReason).toMatchObject({ snapshotId: s.id, pillar: "ADOPTION", kind: "EVIDENCE" });
    expect(s.reasons.length).toBe(agg(10).reasons.length);
    const after = await db.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(after.currentHealthSnapshotId).toBe(r.id);
    // The pointer is a cache: it must not make the account look "updated" (data-quality staleness).
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("re-running with the same inputs changes nothing", async () => {
    const first = await writeSnapshot(db, ws, draft("2026-03-04"));
    const again = await writeSnapshot(db, ws, draft("2026-03-04"));
    expect(again).toEqual({ id: first.id, outcome: "UNCHANGED" });
    expect(await db.healthScoreSnapshot.count({ where: { asOf: new Date("2026-03-04") } })).toBe(1);
  });

  it("new inputs on the same day under the same model replace that day's snapshot", async () => {
    const first = await writeSnapshot(db, ws, draft("2026-03-05", agg(10), "h1"), {
      makeCurrent: true,
    });
    const second = await writeSnapshot(db, ws, draft("2026-03-05", agg(95), "h2"), {
      makeCurrent: true,
    });
    expect(second.outcome).toBe("REPLACED");
    expect(await db.healthScoreSnapshot.count({ where: { asOf: new Date("2026-03-05") } })).toBe(1);
    expect(await db.healthScoreSnapshot.findUnique({ where: { id: first.id } })).toBeNull();
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: accountId } })).currentHealthSnapshotId,
    ).toBe(second.id);
  });

  it("concurrent writers for the same account, model and day all succeed and leave one row", async () => {
    // Two re-score runs can overlap (a model activation while a nightly chunk is running).
    const results = await Promise.all(
      [10, 40, 70, 95].map((a, i) =>
        writeSnapshot(db, ws, draft("2026-03-07", agg(a), `race-${i}`), { makeCurrent: true }),
      ),
    );
    const rows = await db.healthScoreSnapshot.findMany({
      where: { asOf: new Date("2026-03-07") },
    });
    expect(rows).toHaveLength(1);
    expect(results.map((r) => r.id)).toContain(rows[0]!.id);
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: accountId } })).currentHealthSnapshotId,
    ).toBe(rows[0]!.id);
  });

  it("another model version writes its own row; the old version's snapshot is untouched", async () => {
    const v1 = await writeSnapshot(db, ws, draft("2026-03-06"));
    const v2Model = await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 10,
        proposedBy: "HUMAN",
        pillarWeights: {},
        componentConfig: {},
        thresholds: {},
      },
    });
    const v2 = await writeSnapshot(db, ws, draft("2026-03-06", agg(95), "h9", v2Model.id));
    expect(v2.outcome).toBe("CREATED");
    const rows = await db.healthScoreSnapshot.findMany({
      where: { asOf: new Date("2026-03-06") },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.healthModelId)).toEqual([modelId, v2Model.id]);
    expect(rows[0]!.id).toBe(v1.id);
    expect(Number(rows[0]!.overall)).toBe(agg(10).overall);
  });
});
