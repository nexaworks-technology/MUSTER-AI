import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { runSeed } from "../../../../prisma/seed/run";
import { ROSTER } from "../../../../prisma/seed/demo/roster";
import { buildPoints, labelledOutcomes } from "../backtest-service";
import { evaluateModel, searchWeights, sentence } from "../engine/backtest";
import { modelConfigOf } from "../service";

/**
 * SEED_DATA §8's back-test, as the seed actually produces it (founder decision 8, D-59): the
 * numbers in fixtures/backtest-seed.json are what the engine computes on the seed — never tuned
 * to a target. If the engine or seed changes, this fixture changes only with a written reason in
 * the milestone log. Running it twice gives the same numbers.
 */
const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures/backtest-seed.json"), "utf8"),
) as Record<string, unknown>;

let ctx: { workspaceId: string };

beforeAll(async () => {
  // With the second tenant: the isolation check below must always have someone to look at.
  const [ws] = await runSeed({ includeTestTenant: true });
  ctx = { workspaceId: ws!.id };
}, 180_000);

async function run() {
  const { outcomes, window } = await labelledOutcomes(ctx, "2026-11-02");
  // The default model (v1), not whatever is active: e2e runs on this database activate others.
  const model = await scopedDb(ctx).healthModel.findFirstOrThrow({
    where: { proposedBy: "SYSTEM_DEFAULT" },
  });
  const points = await buildPoints(ctx, outcomes, model);
  const c = modelConfigOf(model);
  const def = evaluateModel(points, outcomes, {
    weights: c.pillarWeights,
    thresholds: c.thresholds,
  });
  const s = searchWeights(points, outcomes, { step: 0.05, defaults: c.pillarWeights });
  const summary = (r: typeof def) => ({
    caught: r.caught,
    churns: r.churns,
    renewals: r.renewals,
    falseAlarms: r.falseAlarms,
    meanLeadDays: r.meanLeadDays === null ? null : Math.round(r.meanLeadDays * 100) / 100,
    medianLeadDays: r.medianLeadDays,
    unscorable: r.unscorable.map((u) => u.name),
    caughtAccounts: r.accounts.filter((a) => a.caught).map((a) => `${a.name} (${a.leadDays} days)`),
    falseAlarmAccounts: r.accounts.filter((a) => a.falseAlarm).map((a) => a.name),
    sentence: sentence(r),
  });
  return {
    window,
    outcomes: {
      churns: outcomes.filter((o) => o.type === "CHURN").length,
      renewals: outcomes.filter((o) => o.type === "RENEWAL").length,
    },
    defaultModel: summary(def),
    proposal: {
      weights: s.best.weights,
      thresholds: s.best.thresholds,
      sufficient: s.sufficient,
      ...summary(s.best.result),
    },
  };
}

describe("the seed's back-test (SEED_DATA §8)", () => {
  it("the data's renewals are exactly the 12 documented ones (D-52 seed correction)", async () => {
    const { outcomes } = await labelledOutcomes(ctx, "2026-11-02");
    const documented = ROSTER.filter((a) => a.renewedDaysAgo !== undefined)
      .map((a) => a.name)
      .sort();
    expect(
      outcomes
        .filter((o) => o.type === "RENEWAL")
        .map((o) => o.name)
        .sort(),
    ).toEqual(documented);
    expect(outcomes.filter((o) => o.type === "CHURN")).toHaveLength(12);
  });

  it("matches the recorded fixture exactly, and twice in a row", async () => {
    const first = await run();
    expect(first).toEqual(FIXTURE);
    expect(await run()).toEqual(first);
  }, 120_000);

  it("the workspace's own Larkspur history is what it reads (no other workspace)", async () => {
    const other = await rawDb.workspace.findUnique({ where: { slug: "ferngrove-test" } });
    // Fail loudly: a missing second workspace would make this check pass while asserting nothing.
    expect(other, "the second workspace (ferngrove-test) must be seeded").not.toBeNull();
    const own = await labelledOutcomes(ctx, "2026-11-02");
    const theirs = await labelledOutcomes({ workspaceId: other!.id }, "2026-11-02");
    expect(own.outcomes.length).toBe(24); // control: this workspace's history is there
    const ownIds = new Set(own.outcomes.map((o) => o.accountId));
    expect(theirs.outcomes.filter((o) => ownIds.has(o.accountId))).toEqual([]);
    expect(theirs.outcomes).toEqual([]);
  });
});
