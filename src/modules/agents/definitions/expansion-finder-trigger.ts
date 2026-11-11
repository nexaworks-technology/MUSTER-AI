import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { runAgentsBatch, type BulkJob, type ExecutorDeps } from "../executor";
import { expansionFinder } from "./expansion-finder";

/**
 * The Expansion Finder's trigger (M7 §2): an open opportunity (raised by expansion signals) with no
 * run yet asks the agent once. Without AI configured the sweep does nothing (never fake output).
 */
const SWEEP_CAP = 25;

export async function sweepExpansionAgents(ctx: TenantContext, deps: ExecutorDeps = {}) {
  const db = scopedDb(ctx);
  const open = await db.expansionOpportunity.findMany({
    where: {
      status: { in: ["OPEN", "IN_PROGRESS"] },
      account: { is: { archivedAt: null, lifecycleStage: { not: "LOST" } } },
    },
    select: { id: true, accountId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SWEEP_CAP * 2,
  });
  if (open.length === 0) return { considered: 0, ran: 0 };
  const done = new Set(
    (
      await db.agentRun.findMany({
        where: {
          agentKey: expansionFinder.key,
          triggerType: "opportunity",
          triggerId: { in: open.map((o) => o.id) },
        },
        select: { triggerId: true },
      })
    ).map((r) => r.triggerId),
  );
  // D10: Sweeps skip accounts that have an active published play run
  const activePlayRuns = await db.playRun.findMany({
    where: {
      accountId: { in: open.map((o) => o.accountId) },
      status: { in: ["RUNNING", "WAITING"] },
    },
    select: { accountId: true },
  });
  const playAccounts = new Set(activePlayRuns.map((r) => r.accountId));

  let considered = 0;
  const jobs: BulkJob[] = [];
  for (const o of open) {
    if (done.has(o.id) || playAccounts.has(o.accountId)) continue;
    if (++considered > SWEEP_CAP) break;
    jobs.push({
      def: expansionFinder,
      input: { opportunityId: o.id },
      trigger: { type: "opportunity", id: o.id },
    });
  }
  if (jobs.length === 0) return { considered, ran: 0 };
  // A sweep is bulk work: one batch for the pass (docs/AI-COST-2026-11-11.md, item 2).
  const outcomes = await runAgentsBatch(ctx, jobs, deps);
  if (outcomes.some((o) => o.kind === "not_configured")) {
    logger.info({ workspaceId: ctx.workspaceId }, "expansion notes skipped: AI is not configured");
    return { considered, ran: 0 };
  }
  const ran = outcomes.filter((o) => o.kind === "run" && !o.unchanged).length;
  return { considered, ran };
}

export async function sweepAllExpansionAgents() {
  const out: Record<string, { considered: number; ran: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await sweepExpansionAgents({ workspaceId: w.id });
  return out;
}
