import type { HealthModel, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { addDays, calendarDateOf, todayIn, utcMidnight, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import {
  evaluateModel,
  searchWeights,
  sentence,
  type BacktestPoint,
  type BacktestResult,
  type Candidate,
  type Outcome,
} from "./engine/backtest";
import {
  DEFAULT_COMPONENT_CONFIG,
  PILLARS,
  pillarWeightsSchema,
  type Pillar,
} from "./engine/model";
import { getActiveModel, loadContext, modelConfigOf, scoreAsOf } from "./service";

/**
 * Back-test runs and model versions (ARCHITECTURE §4.5, M3 rules 4–5). Outcomes come from data
 * (D-52); every point is scored with scoreAsOf (no look-ahead); the proposal is a deterministic
 * search; a proposed or edited model never activates by itself.
 */
export const OUTCOME_WINDOW_MONTHS = 24;
export const POINTS_PER_OUTCOME = 17; // weekly, 7…119 days before (the 120-day window)

export interface StoredBacktest {
  kind: "proposal" | "edit";
  generatedAt: string;
  window: { from: string; to: string; months: number };
  sufficient: boolean;
  reason?: string;
  outcomes: Outcome[];
  points: BacktestPoint[];
  result: BacktestResult;
  sentence: string;
  /** The model this one was compared with (the active model when the back-test ran). */
  baseline?: { version: number; result: BacktestResult; sentence: string };
  runnerUp?: {
    weights: Record<Pillar, number>;
    thresholds: { healthyMin: number; watchMin: number };
    result: BacktestResult;
    sentence: string;
  } | null;
  search?: {
    evaluated: number;
    searchMs: number;
    pointsMs: number;
    step: number;
    fixedPillars: Pillar[];
  };
}

/** Churns (CHURN revenue events) and renewals (a contract starting the day the previous ended). */
export async function labelledOutcomes(ctx: TenantContext, today: string) {
  const db = scopedDb(ctx);
  const from = addDays(today, -Math.round(OUTCOME_WINDOW_MONTHS * 30.4375));
  const [churns, contracts, accounts] = await Promise.all([
    db.revenueEvent.findMany({
      where: { type: "CHURN", effectiveDate: { gte: utcMidnight(from), lte: utcMidnight(today) } },
      select: { accountId: true, effectiveDate: true },
    }),
    db.contract.findMany({
      where: { status: { not: "CANCELLED" } },
      select: { accountId: true, startDate: true, endDate: true },
    }),
    db.account.findMany({ select: { id: true, name: true } }),
  ]);
  const name = new Map(accounts.map((a) => [a.id, a.name]));
  const outcomes: Outcome[] = churns.map((c) => ({
    accountId: c.accountId,
    name: name.get(c.accountId) ?? c.accountId,
    type: "CHURN",
    date: calendarDateOf(c.effectiveDate),
  }));
  const ends = new Set(
    contracts.filter((c) => c.endDate).map((c) => `${c.accountId}|${calendarDateOf(c.endDate!)}`),
  );
  for (const c of contracts) {
    const start = calendarDateOf(c.startDate);
    if (start < from || start > today || !ends.has(`${c.accountId}|${start}`)) continue;
    outcomes.push({
      accountId: c.accountId,
      name: name.get(c.accountId) ?? c.accountId,
      type: "RENEWAL",
      date: start,
    });
  }
  outcomes.sort((a, b) =>
    `${a.type}|${a.date}|${a.accountId}` < `${b.type}|${b.date}|${b.accountId}` ? -1 : 1,
  );
  return { outcomes, window: { from, to: today, months: OUTCOME_WINDOW_MONTHS } };
}

/** Pillar scores at every weekly point before every outcome, each computed as of its own date. */
export async function buildPoints(ctx: TenantContext, outcomes: Outcome[], model: HealthModel) {
  const config = modelConfigOf(model);
  const byDate = new Map<string, Array<{ o: Outcome; daysBefore: number }>>();
  for (const o of outcomes)
    for (let k = 1; k <= POINTS_PER_OUTCOME; k++) {
      const asOf = addDays(o.date, -7 * k);
      byDate.set(asOf, [...(byDate.get(asOf) ?? []), { o, daysBefore: 7 * k }]);
    }
  const points: BacktestPoint[] = [];
  const dates = [...byDate.keys()].sort();
  for (let i = 0; i < dates.length; i += 4) {
    await Promise.all(
      dates.slice(i, i + 4).map(async (asOf) => {
        const want = byDate.get(asOf)!;
        const scored = await scoreAsOf(ctx, [...new Set(want.map((w) => w.o.accountId))], asOf, {
          id: model.id,
          config,
        });
        for (const w of want) {
          const s = scored.get(w.o.accountId);
          if (!s) continue;
          points.push({
            accountId: w.o.accountId,
            outcomeDate: w.o.date,
            asOf,
            daysBefore: w.daysBefore,
            tier: s.bundle.tier,
            pillars: s.score.pillars,
          });
        }
      }),
    );
  }
  return points.sort((a, b) =>
    `${a.accountId}|${a.outcomeDate}|${a.asOf}` < `${b.accountId}|${b.outcomeDate}|${b.asOf}`
      ? -1
      : 1,
  );
}

const modelUnderTest = (m: HealthModel) => {
  const c = modelConfigOf(m);
  return {
    weights: c.pillarWeights,
    thresholds: c.thresholds,
    perTierOverrides: c.perTierOverrides,
  };
};

/**
 * The back-test + proposal job: score every point, evaluate the active model, search the weight
 * grid, and store the winner as a DRAFT (proposedBy BACKTEST_PROPOSAL) with its results, the
 * runner-up and timings. Never activates anything.
 */
export async function runBacktestProposal(
  ctx: TenantContext,
  clock: Clock,
  opts: { step?: number } = {},
) {
  const db = scopedDb(ctx);
  const today = todayIn((await loadContext(ctx)).timeZone, clock);
  const active = await getActiveModel(ctx);
  const t0 = performance.now();
  const { outcomes, window } = await labelledOutcomes(ctx, today);
  const points = await buildPoints(ctx, outcomes, active);
  const pointsMs = Math.round(performance.now() - t0);
  const baselineResult = evaluateModel(points, outcomes, modelUnderTest(active));
  const search = searchWeights(points, outcomes, {
    step: opts.step ?? 0.05,
    defaults: modelUnderTest(active).weights,
  });
  const describe = (c: Candidate) => ({ ...c, sentence: sentence(c.result) });
  const stored: StoredBacktest = {
    kind: "proposal",
    generatedAt: clock().toISOString(),
    window,
    sufficient: search.sufficient,
    reason: search.reason,
    outcomes,
    points,
    result: search.best.result,
    sentence: sentence(search.best.result),
    baseline: {
      version: active.version,
      result: baselineResult,
      sentence: sentence(baselineResult),
    },
    runnerUp: search.runnerUp ? describe(search.runnerUp) : null,
    search: {
      evaluated: search.evaluated,
      searchMs: search.ms,
      pointsMs,
      step: search.step,
      fixedPillars: search.fixedPillars,
    },
  };
  return db.$tenantTransaction(async (tx) => {
    const last = await tx.healthModel.aggregate({ _max: { version: true } });
    const draft = await tx.healthModel.create({
      data: {
        workspaceId: ctx.workspaceId,
        version: (last._max.version ?? 0) + 1,
        status: "DRAFT",
        proposedBy: "BACKTEST_PROPOSAL",
        pillarWeights: search.best.weights,
        componentConfig: active.componentConfig as Prisma.InputJsonValue,
        thresholds: { ...search.best.thresholds },
        perTierOverrides: {},
        basedOnVersion: active.version,
        backtestResult: stored as unknown as Prisma.InputJsonValue,
        note: search.sufficient
          ? "Proposed from your own renewed and churned accounts."
          : `Not enough history to propose a model: ${search.reason}`,
      },
    });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: "SYSTEM",
        action: "health_model.proposed",
        targetType: "HealthModel",
        targetId: draft.id,
        summary: `Back-test proposal v${draft.version}: ${stored.sentence}`,
        after: {
          weights: search.best.weights,
          thresholds: { ...search.best.thresholds },
          searchMs: search.ms,
          pointsMs,
        },
      },
      tx,
    );
    return draft;
  });
}

export const modelEditInput = z.object({
  basedOnId: z.string().min(1),
  weights: pillarWeightsSchema,
  thresholds: z
    .object({ healthyMin: z.number().min(1).max(100), watchMin: z.number().min(0).max(99) })
    .refine((t) => t.watchMin < t.healthyMin, { message: "Watch must start below Healthy" }),
  note: z.string().trim().max(500).optional(),
});

/** Preview before save: re-run the back-test for edited weights on the cached points (instant). */
export async function previewModelEdit(actor: Actor, raw: unknown) {
  requirePermission(actor, "healthModel:propose");
  const input = modelEditInput.parse(raw);
  const base = await scopedDb(actor).healthModel.findUniqueOrThrow({
    where: { id: input.basedOnId },
  });
  const stored = base.backtestResult as unknown as StoredBacktest | null;
  if (!stored)
    throw new Error("Run the back-test first: this model has no back-test to compare with.");
  const result = evaluateModel(stored.points, stored.outcomes, {
    weights: input.weights,
    thresholds: input.thresholds,
  });
  return { input, stored, result, sentence: sentence(result) };
}

/** Save an edit as a NEW draft version (old versions are never edited); audited. */
export async function saveModelEdit(actor: Actor, raw: unknown, clock: Clock) {
  const { input, stored, result } = await previewModelEdit(actor, raw);
  const db = scopedDb(actor);
  return db.$tenantTransaction(async (tx) => {
    const base = await tx.healthModel.findUniqueOrThrow({ where: { id: input.basedOnId } });
    const last = await tx.healthModel.aggregate({ _max: { version: true } });
    const record: StoredBacktest = {
      ...stored,
      kind: "edit",
      generatedAt: clock().toISOString(),
      result,
      sentence: sentence(result),
      runnerUp: null,
      search: undefined,
    };
    const draft = await tx.healthModel.create({
      data: {
        workspaceId: actor.workspaceId,
        version: (last._max.version ?? 0) + 1,
        status: "DRAFT",
        proposedBy: "HUMAN",
        pillarWeights: input.weights,
        componentConfig: base.componentConfig as Prisma.InputJsonValue,
        thresholds: input.thresholds,
        perTierOverrides: {},
        basedOnVersion: base.version,
        backtestResult: record as unknown as Prisma.InputJsonValue,
        note: input.note ?? `Edited from v${base.version}.`,
        createdByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "health_model.edited",
        targetType: "HealthModel",
        targetId: draft.id,
        summary: `Saved health model v${draft.version} (from v${base.version}): ${record.sentence}`,
        before: { weights: base.pillarWeights, thresholds: base.thresholds },
        after: { weights: input.weights, thresholds: input.thresholds },
      },
      tx,
    );
    return draft;
  });
}

export class ModelActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelActivationError";
  }
}

/**
 * Activation is an explicit Admin action (M3 rule 5): the draft becomes ACTIVE, the previous
 * ACTIVE is RETIRED, an audit row is written. Old snapshots keep the version that produced them;
 * the caller then queues a re-score, which writes new rows under the new version.
 */
export async function activateModel(actor: Actor, modelId: string) {
  requirePermission(actor, "healthModel:activate");
  const db = scopedDb(actor);
  return db.$tenantTransaction(async (tx) => {
    const draft = await tx.healthModel.findUnique({ where: { id: modelId } });
    if (!draft || draft.status !== "DRAFT")
      throw new ModelActivationError("Only a draft model can be activated.");
    const stored = draft.backtestResult as unknown as StoredBacktest | null;
    if (draft.proposedBy === "BACKTEST_PROPOSAL" && stored && !stored.sufficient)
      throw new ModelActivationError(`This proposal could not be back-tested: ${stored.reason}`);
    const current = await tx.healthModel.findFirst({ where: { status: "ACTIVE" } });
    if (current)
      await tx.healthModel.update({
        where: { id: current.id },
        data: { status: "RETIRED", retiredAt: new Date() },
      });
    const activated = await tx.healthModel.update({
      where: { id: draft.id },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(),
        approvedByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "health_model.activated",
        targetType: "HealthModel",
        targetId: draft.id,
        summary: `Activated health model v${draft.version}${current ? ` (replaces v${current.version})` : ""}${stored ? `: ${stored.sentence}` : ""}`,
        before: current
          ? {
              version: current.version,
              weights: current.pillarWeights,
              thresholds: current.thresholds,
            }
          : undefined,
        after: {
          version: draft.version,
          weights: draft.pillarWeights,
          thresholds: draft.thresholds,
        },
      },
      tx,
    );
    return activated;
  });
}

/** All versions, newest first, for Settings › Health model. */
export async function listModels(actor: Actor) {
  requirePermission(actor, "healthModel:propose");
  const rows = await scopedDb(actor).healthModel.findMany({
    orderBy: { version: "desc" },
    include: {
      createdBy: { select: { user: { select: { name: true, email: true } } } },
      approvedBy: { select: { user: { select: { name: true, email: true } } } },
    },
  });
  return rows.map((r) => ({
    ...r,
    backtest: r.backtestResult as unknown as StoredBacktest | null,
    config: modelConfigOf(r),
  }));
}

/** What each weight means, in plain words (M3 rule 5). */
export const PILLAR_MEANING: Record<Pillar, string> = {
  ADOPTION:
    "How many people use the product against this account's own normal and similar accounts, seats in use, key features, power users.",
  ENGAGEMENT:
    "How recently the customer wrote back, how often our emails get replies, and whether the champion is still in touch.",
  SUPPORT: "Open high-priority tickets, tickets past their target time, and recent escalations.",
  RELATIONSHIP:
    "Whether a champion and a decision maker are known and reachable, how many people we know, and the CSM's Pulse.",
  COMMERCIAL: "Failed or late payments, seat-use trend, and contractions in the last year.",
  SENTIMENT: "The tone of emails, calls and tickets, and survey scores (not measured yet).",
};

export { DEFAULT_COMPONENT_CONFIG, PILLARS };
