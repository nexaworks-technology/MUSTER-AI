import { Prisma, type OutcomeRecord } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { systemClock, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";

/**
 * The outcome ledger's write side for M4 (spec §6L3, ARCHITECTURE §6.5): did anyone act on a
 * flag, and what happened by day 7. Deterministic rules over records, each with evidence. 30/90-day
 * checkpoints and renewal outcomes come in M7/M11.
 */
export interface ActionRef {
  type: "Approval" | "OutboundMessage" | "Task" | "PlayStep";
  id: string;
}

/**
 * A linked action happened (approval approved, message sent, task done): the flag's outcome
 * record becomes ACTED. IGNORED records are re-evaluated (a late action still counts). Idempotent:
 * the same ref is recorded once.
 */
export async function markActed(
  ctx: TenantContext,
  link: { signalId: string },
  ref: ActionRef,
  clock: Clock = systemClock,
): Promise<OutcomeRecord | null> {
  const db = scopedDb(ctx);
  const record = await db.outcomeRecord.findUnique({
    where: { workspaceId_signalId: { workspaceId: ctx.workspaceId, signalId: link.signalId } },
  });
  if (!record) return null;
  const refs = Array.isArray(record.actionRefs)
    ? (record.actionRefs as unknown as ActionRef[])
    : [];
  if (refs.some((r) => r.type === ref.type && r.id === ref.id) && record.actionTaken === "ACTED")
    return record;
  const now = clock();
  return db.$tenantTransaction(async (tx) => {
    const updated = await tx.outcomeRecord.update({
      where: { id: record.id },
      data: {
        actionTaken: "ACTED",
        firstActionAt: record.firstActionAt ?? now,
        actionRefs: [...refs, ref] as unknown as Prisma.InputJsonValue,
      },
    });
    if (record.actionTaken !== "ACTED")
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "outcome.acted",
          targetType: "OutcomeRecord",
          targetId: record.id,
          summary: `Flag acted on (${ref.type})`,
          after: { ref },
        },
        tx,
      );
    return updated;
  });
}

const DAY = 86_400_000;
const BETTER: Record<string, number> = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 };

export interface Checkpoint {
  status: "REPLIED" | "RECOVERED" | "NO_CHANGE";
  evaluatedAt: string;
  actionTaken: "ACTED" | "IGNORED";
  evidence: Array<{ sourceType: string; sourceId: string }>;
  detail: string;
}

/**
 * The 7-day checkpoint (D-79). For each RISK/OPPORTUNITY record flagged ≥ 7 days ago without a
 * d7 result: no action by day 7 → IGNORED; then REPLIED if the account wrote in after the first
 * action and by day 7 (evidence: the message); else RECOVERED if the health band at day 7 is better
 * than at the flag and every snapshot since the first better one stayed better (evidence: the
 * snapshots); else NO_CHANGE. Idempotent: an evaluated record is not evaluated again.
 */
export async function evaluateSevenDayCheckpoints(ctx: TenantContext, clock: Clock = systemClock) {
  const db = scopedDb(ctx);
  const now = clock();
  const due = await db.outcomeRecord.findMany({
    where: {
      d7Outcome: { equals: Prisma.DbNull },
      flaggedAt: { lte: new Date(+now - 7 * DAY) },
    },
  });
  const counts: Record<string, number> = {};
  for (const r of due) {
    const day7 = new Date(+r.flaggedAt + 7 * DAY);
    const actionTaken = r.actionTaken === "ACTED" ? "ACTED" : "IGNORED";
    let cp: Checkpoint;
    const reply =
      r.firstActionAt &&
      (await db.message.findFirst({
        where: {
          accountId: r.accountId,
          direction: "INBOUND",
          sentAt: { gt: r.firstActionAt, lte: day7 },
        },
        orderBy: { sentAt: "asc" },
        select: { id: true },
      }));
    if (reply) {
      cp = {
        status: "REPLIED",
        evaluatedAt: now.toISOString(),
        actionTaken,
        evidence: [{ sourceType: "Message", sourceId: reply.id }],
        detail: "The account wrote back after the first action.",
      };
    } else {
      const snaps = await db.healthScoreSnapshot.findMany({
        where: { accountId: r.accountId, isBacktest: false, asOf: { lte: day7 } },
        orderBy: { asOf: "asc" },
        select: { id: true, asOf: true, riskLevel: true },
      });
      const atFlag = [...snaps].reverse().find((s) => s.asOf <= r.flaggedAt);
      const after = snaps.filter((s) => s.asOf > r.flaggedAt);
      const firstBetter = atFlag
        ? after.findIndex((s) => (BETTER[s.riskLevel] ?? -1) > (BETTER[atFlag.riskLevel] ?? 99))
        : -1;
      const held =
        firstBetter >= 0 &&
        after
          .slice(firstBetter)
          .every((s) => (BETTER[s.riskLevel] ?? -1) > (BETTER[atFlag!.riskLevel] ?? 99));
      cp = held
        ? {
            status: "RECOVERED",
            evaluatedAt: now.toISOString(),
            actionTaken,
            evidence: [atFlag!, ...after.slice(firstBetter)].map((s) => ({
              sourceType: "HealthScoreSnapshot",
              sourceId: s.id,
            })),
            detail: `Health improved from ${atFlag!.riskLevel} and held through day 7.`,
          }
        : {
            status: "NO_CHANGE",
            evaluatedAt: now.toISOString(),
            actionTaken,
            evidence: [],
            detail: "No reply and no lasting health improvement by day 7.",
          };
    }
    await db.outcomeRecord.update({
      where: { id: r.id },
      data: {
        d7Outcome: cp as unknown as Prisma.InputJsonValue,
        ...(r.actionTaken === "PENDING" ? { actionTaken: "IGNORED" } : {}),
      },
    });
    counts[cp.status] = (counts[cp.status] ?? 0) + 1;
  }
  return { evaluated: due.length, counts };
}
