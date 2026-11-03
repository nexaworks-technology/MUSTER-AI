import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  activateModel,
  buildPoints,
  labelledOutcomes,
  ModelActivationError,
  previewModelEdit,
  saveModelEdit,
  type StoredBacktest,
} from "../backtest-service";
import { evaluateModel, sentence } from "../engine/backtest";
import { DEFAULT_MODEL } from "../service";

type Side = Awaited<ReturnType<typeof makeSide>>;
let A: Side;
let B: Side;

async function makeSide(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const model = await db.healthModel.create({
    data: {
      workspaceId: actor.workspaceId,
      version: 1,
      status: "ACTIVE",
      proposedBy: "SYSTEM_DEFAULT",
      pillarWeights: DEFAULT_MODEL.pillarWeights,
      componentConfig: DEFAULT_MODEL.componentConfig as object,
      thresholds: DEFAULT_MODEL.thresholds,
    },
  });
  return { actor, workspaceId: actor.workspaceId, db, model };
}

beforeAll(async () => {
  A = await makeSide("BtTenantA");
  B = await makeSide("BtTenantB");
});

/**
 * The back-test across workspaces (review S2). Self-contained: it uses this file's own two
 * workspaces and creates its own churn history and draft models, so it never depends on another
 * file's seed and cannot pass by skipping. Every attack has a control that proves the data exists.
 */
describe("tenant isolation — the back-test (Rule 2)", () => {
  const TODAY = "2026-11-02";
  const CHURN_DATE = "2026-06-01";
  const clock = () => new Date(`${TODAY}T03:00:00Z`);
  let churnerA: string;
  let churnerB: string;
  let draftA: string;
  let draftB: string;

  async function side(s: Side, label: string) {
    const { db, workspaceId } = s;
    const churner = await db.account.create({
      data: { workspaceId, name: `${label} churner`, tier: "MID_TOUCH" },
    });
    await db.contract.create({
      data: {
        workspaceId,
        accountId: churner.id,
        startDate: utcMidnight(addDays(CHURN_DATE, -365)),
        endDate: utcMidnight(CHURN_DATE),
        renewalDate: utcMidnight(CHURN_DATE),
        status: "ENDED",
        seatsPurchased: 10,
      },
    });
    await db.revenueEvent.create({
      data: {
        workspaceId,
        accountId: churner.id,
        type: "CHURN",
        deltaArrMinor: -1_000_000n,
        currency: "USD",
        effectiveDate: utcMidnight(CHURN_DATE),
        sourceType: "Contract",
        sourceId: label,
      },
    });
    const stored: StoredBacktest = {
      kind: "proposal",
      generatedAt: clock().toISOString(),
      window: { from: "2024-11-01", to: TODAY, months: 24 },
      sufficient: true,
      outcomes: [],
      points: [],
      result: evaluateModel([], [], {
        weights: DEFAULT_MODEL.pillarWeights,
        thresholds: DEFAULT_MODEL.thresholds,
      }),
      sentence: "",
    };
    const draft = await db.healthModel.create({
      data: {
        workspaceId,
        version: 2,
        status: "DRAFT",
        proposedBy: "BACKTEST_PROPOSAL",
        pillarWeights: DEFAULT_MODEL.pillarWeights,
        componentConfig: DEFAULT_MODEL.componentConfig as object,
        thresholds: DEFAULT_MODEL.thresholds,
        backtestResult: { ...stored, sentence: sentence(stored.result) } as object,
      },
    });
    return { churner: churner.id, draft: draft.id };
  }

  beforeAll(async () => {
    const a = await side(A, "BtA");
    const b = await side(B, "BtB");
    churnerA = a.churner;
    churnerB = b.churner;
    draftA = a.draft;
    draftB = b.draft;
  });

  it("labelledOutcomes reads only the caller's own history", async () => {
    const fromA = (await labelledOutcomes(A, TODAY)).outcomes.map((o) => o.accountId);
    const fromB = (await labelledOutcomes(B, TODAY)).outcomes.map((o) => o.accountId);
    expect(fromA).toEqual([churnerA]); // control: A's own churn is there
    expect(fromB).toEqual([churnerB]);
    expect(fromA).not.toContain(churnerB);
  });

  it("buildPoints never scores another workspace's account, even when handed its outcome", async () => {
    const model = await A.db.healthModel.findUniqueOrThrow({ where: { id: draftA } });
    const own = { accountId: churnerA, name: "own", type: "CHURN" as const, date: CHURN_DATE };
    const foreign = {
      accountId: churnerB,
      name: "foreign",
      type: "CHURN" as const,
      date: CHURN_DATE,
    };
    const points = await buildPoints(A, [own, foreign], model);
    expect(points.some((p) => p.accountId === churnerA)).toBe(true); // control
    expect(points.filter((p) => p.accountId === churnerB)).toEqual([]);
  });

  const edit = (basedOnId: string) => ({
    basedOnId,
    weights: DEFAULT_MODEL.pillarWeights,
    thresholds: { healthyMin: 70, watchMin: 40 },
  });

  it("A cannot preview or save an edit based on B's model", async () => {
    await expect(previewModelEdit(A.actor, edit(draftA))).resolves.toBeTruthy(); // control
    await expect(previewModelEdit(A.actor, edit(draftB))).rejects.toThrow();
    await expect(saveModelEdit(A.actor, edit(draftB), clock)).rejects.toThrow();
    const saved = await saveModelEdit(A.actor, edit(draftA), clock); // control
    expect(saved.workspaceId).toBe(A.workspaceId);
    expect(await B.db.healthModel.count()).toBe(2); // nothing was written into B
  });

  it("A cannot activate B's model, and B's models stay as they were", async () => {
    await expect(activateModel(A.actor, draftB)).rejects.toBeInstanceOf(ModelActivationError);
    const b = await B.db.healthModel.findMany({ orderBy: { version: "asc" } });
    expect(b.map((m) => m.status)).toEqual(["ACTIVE", "DRAFT"]);
    const own = await activateModel(A.actor, draftA); // control: the same call on A's own draft works
    expect(own.status).toBe("ACTIVE");
  });
});
