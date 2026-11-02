import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { addDays, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import {
  activateModel,
  labelledOutcomes,
  previewModelEdit,
  runBacktestProposal,
  saveModelEdit,
  type StoredBacktest,
} from "../backtest-service";
import { getActiveModel, scoreAndStore } from "../service";

/**
 * Back-test runs and versions on real records (M3 rules 4–5, D-52): outcomes from data, a
 * deterministic proposal stored as a DRAFT, activation only by an Admin, old snapshots unchanged.
 */
const TODAY = "2026-11-02";
const clock = () => new Date(`${TODAY}T03:00:00Z`);
let admin: Actor;
let leader: Actor;
let ws: string;

async function history(
  name: string,
  outcome: "CHURN" | "RENEWAL",
  date: string,
  dropDays: number | null,
) {
  const db = scopedDb({ workspaceId: ws });
  const a = await db.account.create({
    data: { workspaceId: ws, name, tier: "MID_TOUCH", plan: "Growth" },
  });
  const base = { workspaceId: ws, accountId: a.id };
  const c1 = await db.contract.create({
    data: {
      ...base,
      startDate: utcMidnight(addDays(date, -365)),
      endDate: utcMidnight(date),
      renewalDate: utcMidnight(date),
      status: "ENDED",
      seatsPurchased: 50,
    },
  });
  await db.revenueEvent.create({
    data: {
      ...base,
      type: "NEW",
      deltaArrMinor: 2_000_000n,
      currency: "USD",
      effectiveDate: utcMidnight(addDays(date, -365)),
      sourceType: "Contract",
      sourceId: c1.id,
    },
  });
  if (outcome === "CHURN")
    await db.revenueEvent.create({
      data: {
        ...base,
        type: "CHURN",
        deltaArrMinor: -2_000_000n,
        currency: "USD",
        effectiveDate: utcMidnight(date),
        sourceType: "Contract",
        sourceId: c1.id,
      },
    });
  else
    await db.contract.create({
      data: {
        ...base,
        startDate: utcMidnight(date),
        endDate: utcMidnight(addDays(date, 365)),
        renewalDate: utcMidnight(addDays(date, 365)),
        seatsPurchased: 50,
      },
    });
  const champ = await db.contact.create({ data: { ...base, name: `${name} champion` } });
  await db.stakeholderRole.create({
    data: {
      ...base,
      contactId: champ.id,
      role: "CHAMPION",
      validFrom: new Date(`${addDays(date, -365)}T12:00:00Z`),
    },
  });
  await db.usageDaily.createMany({
    data: Array.from({ length: 220 }, (_, i) => {
      const before = 220 - i; // days before the outcome
      return {
        ...base,
        date: utcMidnight(addDays(date, -before)),
        activeUsers: dropDays !== null && before <= dropDays ? 2 : 40,
        sessions: 0,
        events: 0,
      };
    }),
  });
  return a.id;
}

beforeAll(async () => {
  admin = (await createTestAdmin("Backtest")).actor;
  ws = admin.workspaceId;
  const db = scopedDb(admin);
  const u = await db.user.create({ data: { email: `l-${ws}@example.test`, name: "L" } });
  const m = await db.membership.create({
    data: { workspaceId: ws, userId: u.id, role: "CS_LEADER" },
  });
  leader = { ...admin, userId: u.id, membershipId: m.id, role: "CS_LEADER" };
  const dates = [
    "2026-03-02",
    "2026-04-06",
    "2026-05-04",
    "2026-06-01",
    "2026-07-06",
    "2026-08-03",
  ];
  for (const [i, d] of dates.entries())
    await history(`Churned ${i}`, "CHURN", d, i < 3 ? 70 : null);
  for (const [i, d] of dates.entries()) await history(`Renewed ${i}`, "RENEWAL", d, null);
});

describe("back-test on real records", () => {
  it("labels outcomes from data: churn events and contracts that start the day the last ended", async () => {
    const { outcomes, window } = await labelledOutcomes(admin, TODAY);
    expect(outcomes.filter((o) => o.type === "CHURN")).toHaveLength(6);
    expect(outcomes.filter((o) => o.type === "RENEWAL")).toHaveLength(6);
    expect(window).toMatchObject({ to: TODAY, months: 24 });
  });

  it("proposes a model deterministically, as a DRAFT, and never activates it", async () => {
    const a = await runBacktestProposal(admin, clock, { step: 0.1 });
    const b = await runBacktestProposal(admin, clock, { step: 0.1 });
    expect(a.status).toBe("DRAFT");
    expect(a.proposedBy).toBe("BACKTEST_PROPOSAL");
    const sa = a.backtestResult as unknown as StoredBacktest;
    const sb = b.backtestResult as unknown as StoredBacktest;
    expect(sa.sufficient).toBe(true);
    expect([a.pillarWeights, a.thresholds, sa.result, sa.runnerUp?.result]).toEqual([
      b.pillarWeights,
      b.thresholds,
      sb.result,
      sb.runnerUp?.result,
    ]);
    expect(sa.result.churns).toBe(6);
    expect(sa.result.renewals).toBe(6);
    expect(sa.result.caught).toBeGreaterThanOrEqual(sa.baseline!.result.caught);
    expect(sa.result.caught).toBeLessThanOrEqual(3); // the 3 silent churns cannot be caught
    expect(sa.sentence).toMatch(/^With this model, we would have flagged \d of your last 6 churns/);
    expect((await getActiveModel(admin)).proposedBy).toBe("SYSTEM_DEFAULT");
  });

  it("previews an edit instantly, then saves it as a new version (old versions never change)", async () => {
    const proposal = await scopedDb(admin).healthModel.findFirstOrThrow({
      where: { proposedBy: "BACKTEST_PROPOSAL" },
      orderBy: { version: "desc" },
    });
    const edit = {
      basedOnId: proposal.id,
      weights: {
        ADOPTION: 0.6,
        ENGAGEMENT: 0.1,
        SUPPORT: 0.1,
        RELATIONSHIP: 0.1,
        COMMERCIAL: 0.05,
        SENTIMENT: 0.05,
      },
      thresholds: { healthyMin: 70, watchMin: 55 },
    };
    const preview = await previewModelEdit(leader, edit);
    expect(preview.result.churns).toBe(6);
    const saved = await saveModelEdit(leader, edit, clock);
    expect(saved).toMatchObject({
      status: "DRAFT",
      proposedBy: "HUMAN",
      basedOnVersion: proposal.version,
    });
    expect(saved.version).toBeGreaterThan(proposal.version);
    const again = await scopedDb(admin).healthModel.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(again.pillarWeights).toEqual(proposal.pillarWeights);
  });

  it("only an Admin activates; the old version retires; old snapshots keep their version", async () => {
    const db = scopedDb(admin);
    const v1 = await getActiveModel(admin);
    const acct = await db.account.findFirstOrThrow({ where: { name: "Renewed 5" } });
    const [old] = [...(await scoreAndStore(admin, [acct.id], "2026-07-01", v1)).values()];
    const draft = await db.healthModel.findFirstOrThrow({ where: { proposedBy: "HUMAN" } });
    await expect(activateModel(leader, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    await activateModel(admin, draft.id);
    expect((await db.healthModel.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe(
      "RETIRED",
    );
    expect((await getActiveModel(admin)).id).toBe(draft.id);
    expect(
      await db.auditLog.count({ where: { action: "health_model.activated", targetId: draft.id } }),
    ).toBe(1);
    await scoreAndStore(admin, [acct.id], "2026-07-01", await getActiveModel(admin));
    const rows = await db.healthScoreSnapshot.findMany({
      where: { accountId: acct.id, asOf: utcMidnight("2026-07-01") },
    });
    expect(rows.map((r) => r.healthModelId).sort()).toEqual([v1.id, draft.id].sort());
    expect(rows.find((r) => r.id === old!.id)).toBeTruthy();
  });

  it("refuses to activate a proposal that could not be back-tested", async () => {
    const thin = await createTestAdmin("BacktestThin");
    const draft = await runBacktestProposal(thin.actor, clock, { step: 0.25 });
    expect((draft.backtestResult as unknown as StoredBacktest).sufficient).toBe(false);
    await expect(activateModel(thin.actor, draft.id)).rejects.toThrow(/could not be back-tested/);
  });
});
