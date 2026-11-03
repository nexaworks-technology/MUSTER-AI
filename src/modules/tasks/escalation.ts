import { writeAudit } from "@/lib/audit";
import { addDays, startOfLocalDay, systemClock, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { getSettingsData } from "@/modules/settings/service";

/**
 * Overdue escalation (spec §6F3, M4 §2): an open task more than `escalateAfterDays` past its due
 * date escalates once: `escalatedAt` is set, every active CS Leader gets a TASK_OVERDUE
 * notification (their Today lists it as an escalated task), the owner is told, the escalation is
 * audited, and a `task.overdue` event is recorded for plays (M8). Idempotent: escalated tasks are
 * skipped, so the daily job and a re-run never notify twice.
 */
export async function escalateOverdueTasks(ctx: TenantContext, clock: Clock = systemClock) {
  const db = scopedDb(ctx);
  const ws = await getOwnWorkspace(ctx);
  const { tasks: cfg } = await getSettingsData(ctx.workspaceId);
  // Due before the start of (today − escalateAfterDays + 1) in the workspace's time zone.
  const cutoff = startOfLocalDay(
    addDays(todayIn(ws.timezone, clock), -cfg.escalateAfterDays + 1),
    ws.timezone,
  );
  const overdue = await db.task.findMany({
    where: { status: "OPEN", escalatedAt: null, dueAt: { not: null, lt: cutoff } },
    include: {
      owner: { include: { user: { select: { name: true } } } },
      account: { select: { name: true } },
    },
  });
  if (!overdue.length) return { escalated: 0 };
  const leaders = await db.membership.findMany({
    where: { role: "CS_LEADER", status: "ACTIVE" },
    select: { id: true },
  });
  const now = clock();
  for (const t of overdue)
    await db.$tenantTransaction(async (tx) => {
      // Claim the task so two runs never escalate it twice.
      const claimed = await tx.task.updateMany({
        where: { id: t.id, escalatedAt: null },
        data: { escalatedAt: now },
      });
      if (claimed.count === 0) return;
      const where = t.account ? ` (${t.account.name})` : "";
      const recipients = new Set([...leaders.map((l) => l.id), t.ownerMembershipId]);
      for (const recipientMembershipId of recipients)
        await tx.notification.create({
          data: {
            workspaceId: ctx.workspaceId,
            recipientMembershipId,
            type: "TASK_OVERDUE",
            title:
              recipientMembershipId === t.ownerMembershipId
                ? `Overdue and escalated to your CS Leader: ${t.title}${where}`
                : `Overdue: ${t.owner.user.name ?? "A CSM"}'s task "${t.title}"${where}`,
            refType: "Task",
            refId: t.id,
            accountId: t.accountId,
          },
        });
      await writeOutboxEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: "task.overdue",
        payload: {
          taskId: t.id,
          ownerMembershipId: t.ownerMembershipId,
          dueAt: t.dueAt!.toISOString(),
        },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "task.escalated",
          targetType: "Task",
          targetId: t.id,
          summary: `Overdue task escalated to ${leaders.length} CS Leader(s): ${t.title}`,
          after: { escalatedAt: now.toISOString(), leaders: leaders.map((l) => l.id) },
        },
        tx,
      );
    });
  return { escalated: overdue.length };
}
