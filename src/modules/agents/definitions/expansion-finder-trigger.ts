import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { runAgent, type ExecutorDeps } from "../executor";
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
  let ran = 0;
  for (const o of open) {
    if (done.has(o.id) || playAccounts.has(o.accountId)) continue;
    if (++considered > SWEEP_CAP) break;
    const r = await runAgent(
      ctx,
      expansionFinder,
      { opportunityId: o.id },
      { type: "opportunity", id: o.id },
      deps,
    );
    if (r.kind === "not_configured") {
      logger.info(
        { workspaceId: ctx.workspaceId },
        "expansion notes skipped: AI is not configured",
      );
      break;
    }
    ran++;
  }
  return { considered, ran };
}

export async function sweepAllExpansionAgents() {
  const out: Record<string, { considered: number; ran: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await sweepExpansionAgents({ workspaceId: w.id });
  return out;
}
