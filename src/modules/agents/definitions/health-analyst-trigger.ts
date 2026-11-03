import { z } from "zod";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { displayedSnapshot, getActiveModel } from "@/modules/health/service";
import { logger } from "@/lib/logger";
import { runAgent, type ExecutorDeps } from "../executor";
import { healthAnalyst } from "./health-analyst";

/**
 * When the Health Analyst runs (M4 §2, founder point 8): the band changed, the top reason
 * changed, or an account's first snapshot is not Healthy. Deterministic; one run per snapshot
 * (the run's idempotency key includes the snapshot id), so the outbox event and the sweep can
 * both fire without a second model call.
 */
interface SnapshotFacts {
  id: string;
  riskLevel: string;
  reasons: Array<{ kind: string; impact: number; component: string; input: string }>;
}

/** The most negative evidence reason ("component/input"), or null when nothing pulls down. */
export function topReasonKey(s: SnapshotFacts): string | null {
  let best: SnapshotFacts["reasons"][number] | null = null;
  for (const r of s.reasons)
    if (r.kind === "EVIDENCE" && r.impact < 0 && (best === null || r.impact < best.impact))
      best = r;
  return best ? `${best.component}/${best.input}` : null;
}

export function needsNarrative(
  current: SnapshotFacts,
  previous: SnapshotFacts | null,
): string | null {
  if (!previous) return current.riskLevel === "HEALTHY" ? null : "first snapshot is not Healthy";
  if (previous.riskLevel !== current.riskLevel)
    return `band changed ${previous.riskLevel} → ${current.riskLevel}`;
  const was = topReasonKey(previous);
  const now = topReasonKey(current);
  return was !== now ? "top reason changed" : null;
}

const reasonSelect = {
  select: { kind: true, impact: true, component: true, input: true },
} as const;

/** Decides for one account's current snapshot and runs the agent when a trigger fires. */
export async function considerHealthNarrative(
  ctx: TenantContext,
  accountId: string,
  deps: ExecutorDeps = {},
) {
  const db = scopedDb(ctx);
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { lifecycleStage: true },
  });
  // The snapshot the Health tab shows, so every link in the narrative lands on a reason there.
  const shown =
    account && account.lifecycleStage !== "LOST" ? await displayedSnapshot(ctx, accountId) : null;
  if (!shown) return { ran: false as const, why: "no current snapshot" };
  const current = await db.healthScoreSnapshot.findUniqueOrThrow({
    where: { id: shown.id },
    include: { reasons: reasonSelect },
  });
  const previous = await db.healthScoreSnapshot.findFirst({
    where: {
      accountId,
      isBacktest: false,
      createdAt: { lt: current.createdAt },
      id: { not: current.id },
    },
    orderBy: { createdAt: "desc" },
    include: { reasons: reasonSelect },
  });
  const facts = (s: typeof current): SnapshotFacts => ({
    id: s.id,
    riskLevel: s.riskLevel,
    reasons: s.reasons.map((r) => ({ ...r, impact: Number(r.impact) })),
  });
  const why = needsNarrative(facts(current), previous && facts(previous));
  if (!why) return { ran: false as const, why: "no trigger" };
  const outcome = await runAgent(
    ctx,
    healthAnalyst,
    { accountId, snapshotId: current.id },
    { type: "snapshot", id: current.id },
    deps,
  );
  return { ran: true as const, why, outcome };
}

export const considerPayload = z.object({
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
});

/** Outbox `health.bandChanged` → this job (the event's payload carries accountId). */
export async function processConsider(raw: unknown) {
  const p = considerPayload.parse(raw);
  return considerHealthNarrative({ workspaceId: p.workspaceId }, p.accountId);
}

/**
 * The sweep: every current snapshot without a Health Analyst run yet is considered once. Catches
 * top-reason changes and first snapshots, which have no event of their own.
 */
export async function sweepHealthNarratives(ctx: TenantContext, deps: ExecutorDeps = {}) {
  const db = scopedDb(ctx);
  const model = await getActiveModel(ctx);
  // The snapshot each Health tab shows: the latest live one under the active model, per account.
  const shown = await db.healthScoreSnapshot.findMany({
    where: {
      healthModelId: model.id,
      isBacktest: false,
      account: { lifecycleStage: { not: "LOST" }, archivedAt: null },
    },
    orderBy: [{ accountId: "asc" }, { asOf: "desc" }],
    distinct: ["accountId"],
    select: { id: true, accountId: true },
  });
  const accounts = shown.map((s) => ({ id: s.accountId, snapshotId: s.id }));
  const done = new Set(
    (
      await db.agentRun.findMany({
        where: {
          agentKey: healthAnalyst.key,
          triggerType: "snapshot",
          triggerId: { in: accounts.map((a) => a.snapshotId) },
        },
        select: { triggerId: true },
      })
    ).map((r) => r.triggerId),
  );
  let ran = 0;
  for (const a of accounts) {
    if (done.has(a.snapshotId)) continue;
    const r = await considerHealthNarrative(ctx, a.id, deps);
    if (r.ran && r.outcome.kind === "not_configured") {
      logger.info(
        { workspaceId: ctx.workspaceId },
        "health narratives skipped: AI is not configured",
      );
      break;
    }
    if (r.ran) ran++;
  }
  return { considered: accounts.length - done.size, ran };
}
