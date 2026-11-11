import { estimateRunCostUsd } from "@/config/ai-pricing";
import { businessClock, startOfLocalDay, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { getSettingsData } from "@/modules/settings/service";

/**
 * The monthly AI budget (docs/AI-COST-2026-11-11.md, item 5). Tokens are counted per workspace per
 * calendar month in the workspace's time zone, all kinds together (input, output, cache reads and
 * writes). At 80 % a soft alert goes to Admins and CS Leaders once a month; at 100 % every job
 * except the essential ones pauses. The cost figure is an ESTIMATE from `config/ai-pricing.ts`.
 */
export const SOFT_ALERT_PERCENT = 80;
export const PAUSE_PERCENT = 100;
/** Jobs that keep running at 100 %: a person is waiting on the answer. One list. */
export const ESSENTIAL_AI_JOBS: readonly string[] = ["ask-ai"];

export type BudgetLevel = "OK" | "SOFT" | "PAUSED";

export interface BudgetStatus {
  /** `YYYY-MM`, the workspace's current month. */
  month: string;
  budgetTokens: number;
  usedTokens: number;
  percent: number;
  level: BudgetLevel;
  /** Estimated USD month to date: token counts × list prices (a labelled estimate, not an invoice). */
  estimatedCostUsd: number;
  runs: number;
  batchedRuns: number;
  cacheReadTokens: number;
  byTier: Array<{ tier: string; runs: number; tokens: number; estimatedCostUsd: number }>;
}

interface TokenSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  planningInputTokens: number;
  planningOutputTokens: number;
}

const total = (r: TokenSums) =>
  r.inputTokens +
  r.outputTokens +
  r.cacheReadTokens +
  r.cacheCreationTokens +
  r.planningInputTokens +
  r.planningOutputTokens;

const sums = (g: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  planningInputTokens: number | null;
  planningOutputTokens: number | null;
}): TokenSums => ({
  inputTokens: g.inputTokens ?? 0,
  outputTokens: g.outputTokens ?? 0,
  cacheReadTokens: g.cacheReadTokens ?? 0,
  cacheCreationTokens: g.cacheCreationTokens ?? 0,
  planningInputTokens: g.planningInputTokens ?? 0,
  planningOutputTokens: g.planningOutputTokens ?? 0,
});

async function monthWindow(ctx: TenantContext, clock: Clock) {
  const ws = await getOwnWorkspace(ctx);
  const month = todayIn(ws.timezone, clock).slice(0, 7);
  return { month, since: startOfLocalDay(`${month}-01`, ws.timezone) };
}

export const levelOf = (percent: number): BudgetLevel =>
  percent >= PAUSE_PERCENT ? "PAUSED" : percent >= SOFT_ALERT_PERCENT ? "SOFT" : "OK";

/** Month-to-date usage and estimate, grouped by tier and by batch (batched runs cost half). */
export async function budgetStatus(
  ctx: TenantContext,
  clock: Clock = businessClock,
): Promise<BudgetStatus> {
  const [{ month, since }, settings] = await Promise.all([
    monthWindow(ctx, clock),
    getSettingsData(ctx.workspaceId),
  ]);
  const db = scopedDb(ctx);
  const select = {
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      planningInputTokens: true,
      planningOutputTokens: true,
    },
    _count: { _all: true },
  } as const;
  const [groups, batchedGroups] = await Promise.all([
    db.agentRun.groupBy({ by: ["modelTier"], where: { createdAt: { gte: since } }, ...select }),
    db.agentRun.groupBy({
      by: ["modelTier"],
      where: { createdAt: { gte: since }, batchId: { not: null } },
      ...select,
    }),
  ]);
  const batchedBy = new Map(batchedGroups.map((g) => [g.modelTier, g]));
  let usedTokens = 0;
  let cost = 0;
  let runs = 0;
  let cacheRead = 0;
  const byTier = groups.map((g) => {
    const all = sums(g._sum);
    const b = batchedBy.get(g.modelTier);
    const batched = b
      ? sums(b._sum)
      : sums({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          planningInputTokens: 0,
          planningOutputTokens: 0,
        });
    const real: TokenSums = {
      inputTokens: all.inputTokens - batched.inputTokens,
      outputTokens: all.outputTokens - batched.outputTokens,
      cacheReadTokens: all.cacheReadTokens - batched.cacheReadTokens,
      cacheCreationTokens: all.cacheCreationTokens - batched.cacheCreationTokens,
      planningInputTokens: all.planningInputTokens - batched.planningInputTokens,
      planningOutputTokens: all.planningOutputTokens - batched.planningOutputTokens,
    };
    const tierCost =
      estimateRunCostUsd({ modelTier: g.modelTier, ...real, batched: false }) +
      estimateRunCostUsd({ modelTier: g.modelTier, ...batched, batched: true });
    usedTokens += total(all);
    cost += tierCost;
    runs += g._count._all;
    cacheRead += all.cacheReadTokens;
    return {
      tier: g.modelTier,
      runs: g._count._all,
      tokens: total(all),
      estimatedCostUsd: tierCost,
    };
  });
  const budgetTokens = settings.ai.monthlyTokenBudget;
  const percent =
    budgetTokens === 0 ? (usedTokens > 0 ? 100 : 0) : (usedTokens / budgetTokens) * 100;
  return {
    month,
    budgetTokens,
    usedTokens,
    percent,
    level: budgetTokens === 0 ? "PAUSED" : levelOf(percent),
    estimatedCostUsd: cost,
    runs,
    batchedRuns: batchedGroups.reduce((n, g) => n + g._count._all, 0),
    cacheReadTokens: cacheRead,
    byTier: byTier.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
  };
}

/** True when this job must not run now: the month's budget is used up and the job is not essential. */
export async function isPausedForBudget(
  ctx: TenantContext,
  jobKey: string,
  clock: Clock = businessClock,
): Promise<boolean> {
  if (ESSENTIAL_AI_JOBS.includes(jobKey)) return false;
  return (await budgetStatus(ctx, clock)).level === "PAUSED";
}

/**
 * The 80 % soft alert: one in-app notification per Admin and CS Leader per month, written the
 * first time usage reaches the line. Safe to call after every run.
 */
export async function noteBudgetUsage(
  ctx: TenantContext,
  clock: Clock = businessClock,
): Promise<void> {
  const st = await budgetStatus(ctx, clock);
  if (st.level === "OK") return;
  const db = scopedDb(ctx);
  const leaders = await db.membership.findMany({
    where: { role: { in: ["ADMIN", "CS_LEADER"] } },
    select: { id: true },
  });
  const title =
    `AI usage is at ${Math.floor(st.percent)} % of this month's budget ` +
    `(about $${st.estimatedCostUsd.toFixed(2)}, an estimate). ` +
    (st.level === "PAUSED"
      ? "Non-essential AI jobs are paused; Ask AI still works."
      : "Non-essential AI jobs pause at 100 %.");
  for (const m of leaders) {
    const already = await db.notification.findFirst({
      where: {
        recipientMembershipId: m.id,
        type: "AI_BUDGET_SOFT",
        refType: "AiBudget",
        refId: st.month,
      },
      select: { id: true },
    });
    if (already) continue;
    await db.notification.create({
      data: {
        workspaceId: ctx.workspaceId,
        recipientMembershipId: m.id,
        type: "AI_BUDGET_SOFT",
        title,
        refType: "AiBudget",
        refId: st.month,
      },
    });
  }
}
