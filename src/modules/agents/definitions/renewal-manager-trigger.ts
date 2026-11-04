import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { runAgent, type ExecutorDeps } from "../executor";
import { renewalManager } from "./renewal-manager";

/**
 * The Renewal Manager's trigger (M7 §2): an open renewal-window signal (90, 60 or 30 days) on a
 * renewal that has no brief yet asks the agent once, per signal. The 90-day signal is the first
 * to open; the later windows catch a renewal first seen late. A person can also ask from the
 * brief page. Without AI configured the sweep does nothing (never fake output).
 */
const WINDOW_RULES = ["renewal_window_90", "renewal_window_60", "renewal_window_30"] as const;
const SWEEP_CAP = 25;

export async function sweepRenewalAgents(ctx: TenantContext, deps: ExecutorDeps = {}) {
  const db = scopedDb(ctx);
  const signals = await db.signal.findMany({
    where: {
      ruleKey: { in: [...WINDOW_RULES] },
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      account: { is: { archivedAt: null, lifecycleStage: { not: "LOST" } } },
    },
    select: { id: true, accountId: true, dedupeKey: true },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    take: SWEEP_CAP * 3,
  });
  if (signals.length === 0) return { considered: 0, ran: 0 };
  const renewals = await db.renewal.findMany({
    where: {
      accountId: { in: [...new Set(signals.map((s) => s.accountId))] },
      stage: { in: ["UPCOMING", "IN_PROGRESS"] },
      briefDocumentId: null,
    },
    select: { id: true, accountId: true, contractId: true, renewalDate: true },
  });
  const ran = new Set(
    (
      await db.agentRun.findMany({
        where: {
          agentKey: renewalManager.key,
          triggerType: "signal",
          triggerId: { in: signals.map((s) => s.id) },
        },
        select: { triggerId: true },
      })
    ).map((r) => r.triggerId),
  );
  let considered = 0;
  let asked = 0;
  const seen = new Set<string>();
  for (const s of signals) {
    // dedupeKey: <rule>:<accountId>:<contractId>:<renewalDate>
    const [, , contractId, date] = s.dedupeKey.split(":");
    const renewal = renewals.find(
      (r) =>
        r.accountId === s.accountId &&
        r.contractId === contractId &&
        r.renewalDate.toISOString().slice(0, 10) === date,
    );
    if (!renewal || seen.has(renewal.id) || ran.has(s.id)) continue;
    seen.add(renewal.id);
    if (++considered > SWEEP_CAP) break;
    const r = await runAgent(
      ctx,
      renewalManager,
      { renewalId: renewal.id },
      { type: "signal", id: s.id },
      deps,
    );
    if (r.kind === "not_configured") {
      logger.info({ workspaceId: ctx.workspaceId }, "renewal plans skipped: AI is not configured");
      break;
    }
    asked++;
  }
  return { considered, ran: asked };
}

export async function sweepAllRenewalAgents() {
  const out: Record<string, { considered: number; ran: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await sweepRenewalAgents({ workspaceId: w.id });
  return out;
}
