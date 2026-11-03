import type { OutboundMessage, Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { systemClock, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { customerTransport, type CustomerTransport } from "@/lib/email/customerTransport";
import { getSettingsData } from "@/modules/settings/service";
import { evaluateGuards, type GuardResult } from "./guards";
import { detectSensitive } from "./sensitive";

/**
 * The single customer-send path (ARCHITECTURE §7.4, CLAUDE.md Rule 3). Nothing else may import
 * the customer transport. Every send, human-approved or automatic, passes the pre-checks below;
 * an automatic send must also pass all 8 guards. A failure never drops a message silently: an
 * approved send is refused with its reasons; an automatic one is HELD and routed to Approvals.
 *
 * Pre-checks on EVERY send (founder point 2):
 *   - the linked approval is APPROVED / EDITED_APPROVED, decided in the app by a member who
 *     still has approvals:decide on this account, at DRAFT_FOR_APPROVAL (the level a human
 *     signs off); a sensitive approval decided from Slack is refused (Q-31);
 *   - the text being sent is exactly the latest approved draft version;
 *   - the approval carries proof (≥ 1 source), and an AI draft comes from a SUCCEEDED run;
 *   - guard 7: the address is not suppressed, the contact has not bounced or left.
 * The kill switch (guard 8) blocks automatic sends only; a human-approved send does not depend
 * on it (founder clarification A).
 */
export class DispatchRefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Not sent: ${reasons.join("; ")}`);
    this.name = "DispatchRefusedError";
  }
}

export type DispatchResult =
  | { status: "SENT"; providerMessageId: string; transport: string }
  | { status: "ALREADY_SENT"; providerMessageId: string | null }
  | { status: "HELD"; heldReason: string; approvalId: string };

export interface DispatchDeps {
  clock?: Clock;
  /** Tests inject a fake; production and dev use the configured customer transport. */
  transport?: CustomerTransport;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const SENDABLE = ["AWAITING_APPROVAL", "HELD", "FAILED"] as const;

type Check = GuardResult | { guard: string; passed: boolean; detail: string };

async function preChecks(ctx: TenantContext, m: OutboundMessage): Promise<Check[]> {
  const db = scopedDb(ctx);
  const checks: Check[] = [];
  const approval = m.approvalId
    ? await db.approval.findUnique({
        where: { id: m.approvalId },
        include: { decidedBy: true, account: { select: { ownerMembershipId: true } } },
      })
    : null;

  if (m.sendMode === "APPROVED") {
    const decided =
      approval && (approval.status === "APPROVED" || approval.status === "EDITED_APPROVED");
    checks.push({
      guard: "approval_approved",
      passed: Boolean(decided),
      detail: approval
        ? `The approval is ${approval.status.toLowerCase().replaceAll("_", " ")}.`
        : "There is no approval for this message.",
    });
    const member = approval?.decidedBy;
    const grant = member && member.status === "ACTIVE" ? can(member, "approvals:decide") : null;
    const inBook =
      grant &&
      (grant.scope === "ALL" ||
        approval!.account.ownerMembershipId === member!.id ||
        (grant.scope === "TEAM" && approval!.account.ownerMembershipId === null));
    checks.push({
      guard: "approver_permitted",
      passed: Boolean(decided && inBook),
      detail: inBook
        ? "Approved by a member who may decide on this account."
        : "Nobody with permission for this account approved it.",
    });
    checks.push({
      guard: "approval_level",
      passed: approval?.requiredLevel === "DRAFT_FOR_APPROVAL",
      detail: approval
        ? `The approval's level is ${approval.requiredLevel}; a human-approved send needs DRAFT_FOR_APPROVAL.`
        : "No approval level.",
    });
    checks.push({
      guard: "decided_in_app",
      passed: Boolean(approval && !(approval.isSensitive && approval.decidedVia === "SLACK")),
      detail:
        approval?.isSensitive && approval.decidedVia === "SLACK"
          ? "A sensitive approval cannot be decided from Slack (Q-31)."
          : "Decided in the app.",
    });
    const latest = approval
      ? await db.draftRevision.findFirst({
          where: { approvalId: approval.id },
          orderBy: { version: "desc" },
        })
      : null;
    checks.push({
      guard: "approved_version",
      passed: Boolean(latest && latest.subject === m.subject && latest.bodyText === m.bodyText),
      detail: latest
        ? latest.subject === m.subject && latest.bodyText === m.bodyText
          ? `Sending version ${latest.version}, the approved text.`
          : "The message differs from the approved version."
        : "No approved version exists.",
    });
  }

  const proof = Array.isArray(approval?.proof) ? approval.proof.length : 0;
  checks.push({
    guard: "has_sources",
    passed: proof >= 1,
    detail: proof >= 1 ? `Cites ${proof} source(s).` : "The draft cites no source.",
  });
  if (m.origin === "AI") {
    const run = m.agentRunId ? await db.agentRun.findUnique({ where: { id: m.agentRunId } }) : null;
    checks.push({
      guard: "ai_run_succeeded",
      passed: run?.status === "SUCCEEDED",
      detail: run ? `The drafting run is ${run.status}.` : "The AI draft has no run.",
    });
  }
  return checks;
}

async function guardContext(ctx: TenantContext, m: OutboundMessage, now: Date) {
  const db = scopedDb(ctx);
  const [contact, account, lastToContact, lastToAccount, tickets, suppression, approval, settings] =
    await Promise.all([
      db.contact.findUniqueOrThrow({ where: { id: m.contactId } }),
      db.account.findUniqueOrThrow({ where: { id: m.accountId } }),
      db.outboundMessage.findFirst({
        where: { contactId: m.contactId, status: "SENT", id: { not: m.id } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
      db.outboundMessage.findFirst({
        where: { accountId: m.accountId, status: "SENT", id: { not: m.id } },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
      db.ticket.findMany({
        where: {
          accountId: m.accountId,
          status: { in: ["OPEN", "PENDING"] },
          OR: [{ priority: { in: ["HIGH", "URGENT"] } }, { isEscalated: true }],
        },
        select: { id: true },
      }),
      db.emailSuppression.findUnique({
        where: {
          workspaceId_email: { workspaceId: ctx.workspaceId, email: m.toEmail.toLowerCase() },
        },
      }),
      m.approvalId ? db.approval.findUnique({ where: { id: m.approvalId } }) : null,
      getSettingsData(ctx.workspaceId),
    ]);
  // Re-check the topic on the exact text being sent, on top of what the approval recorded.
  const fresh = detectSensitive({ texts: [m.subject, m.bodyText] });
  const reasons = [...new Set([...(approval?.sensitiveReasons ?? []), ...fresh.reasons])];
  return {
    now,
    contact: {
      email: m.toEmail || contact.email,
      timezone: contact.timezone,
      status: contact.status,
    },
    account: { timezone: account.timezone, lifecycleStage: account.lifecycleStage },
    lastSentToContactAt: lastToContact?.sentAt ?? null,
    lastOtherSendToAccountAt: lastToAccount?.sentAt ?? null,
    openSeriousTicketIds: tickets.map((t) => t.id),
    sensitive: { isSensitive: Boolean(approval?.isSensitive) || reasons.length > 0, reasons },
    suppression: suppression ? { reason: suppression.reason } : null,
    autoSendEnabled: settings.outbound.autoSendEnabled,
    quiet: {
      startHour: settings.outbound.quietStartHour,
      endHour: settings.outbound.quietEndHour,
      weekends: settings.outbound.quietOnWeekends,
    },
    contactCooldownHours: settings.outbound.contactCooldownHours,
    otherPlayCooldownHours: settings.outbound.otherPlayCooldownHours,
  };
}

export async function dispatch(
  ctx: TenantContext,
  outboundMessageId: string,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const db = scopedDb(ctx);
  const now = (deps.clock ?? systemClock)();
  const m = await db.outboundMessage.findUniqueOrThrow({ where: { id: outboundMessageId } });
  if (m.status === "SENT")
    return { status: "ALREADY_SENT", providerMessageId: m.providerMessageId };

  const checks = await preChecks(ctx, m);
  const gctx = await guardContext(ctx, m, now);
  const guards = evaluateGuards(gctx);
  const suppressed = guards.find((g) => g.guard === "suppressed")!;
  const results: Check[] = [...checks, ...guards];
  const blocking =
    m.sendMode === "APPROVED"
      ? [...checks, suppressed].filter((c) => !c.passed)
      : [...checks, ...guards].filter((c) => !c.passed);

  if (blocking.length) {
    const heldReason = blocking.map((b) => b.detail).join(" ");
    if (m.sendMode === "APPROVED") {
      await db.$tenantTransaction(async (tx) => {
        await tx.outboundMessage.update({
          where: { id: m.id },
          data: { status: "HELD", heldReason, guardResults: json(results) },
        });
        await writeAudit(
          {
            workspaceId: ctx.workspaceId,
            actorType: "SYSTEM",
            action: "outbound.refused",
            targetType: "OutboundMessage",
            targetId: m.id,
            summary: `Not sent: ${blocking.map((b) => b.guard).join(", ")}`,
            after: { guardResults: results },
          },
          tx,
        );
      });
      throw new DispatchRefusedError(blocking.map((b) => `${b.guard}: ${b.detail}`));
    }
    // An automatic send that fails a guard is held and goes to a human (§7.4).
    const approvalId = await db.$tenantTransaction(async (tx) => {
      const approval =
        (m.approvalId && (await tx.approval.findUnique({ where: { id: m.approvalId } }))) ||
        (await tx.approval.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: m.accountId,
            kind: "SEND_EMAIL",
            reason: `Held by the send guards: ${heldReason}`,
            proof: [{ sourceType: "OutboundMessage", sourceId: m.id }],
            requiredLevel: "DRAFT_FOR_APPROVAL",
            isSensitive: gctx.sensitive.isSensitive,
            sensitiveReasons: gctx.sensitive.reasons,
            sourceKey: `held:${m.id}`,
          },
        }));
      await tx.outboundMessage.update({
        where: { id: m.id },
        data: {
          status: "HELD",
          heldReason,
          guardResults: json(results),
          approvalId: approval.id,
          sendMode: "APPROVED",
        },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "outbound.held",
          targetType: "OutboundMessage",
          targetId: m.id,
          summary: `Held for approval: ${blocking.map((b) => b.guard).join(", ")}`,
          after: { guardResults: results, approvalId: approval.id },
        },
        tx,
      );
      return approval.id;
    });
    return { status: "HELD", heldReason, approvalId };
  }

  // Claim the message so two concurrent dispatches can never both send it.
  const claimed = await db.outboundMessage.updateMany({
    where: { id: m.id, status: { in: [...SENDABLE] } },
    data: { status: "QUEUED", guardResults: json(results), heldReason: null },
  });
  if (claimed.count === 0) {
    const now2 = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
    if (now2.status === "SENT")
      return { status: "ALREADY_SENT", providerMessageId: now2.providerMessageId };
    throw new DispatchRefusedError([
      `the message is ${now2.status.toLowerCase()}, not ready to send`,
    ]);
  }

  const transport = deps.transport ?? customerTransport();
  let providerMessageId: string;
  try {
    ({ id: providerMessageId } = await transport.send({
      workspaceId: ctx.workspaceId,
      outboundMessageId: m.id,
      to: m.toEmail,
      subject: m.subject,
      text: m.bodyText,
    }));
  } catch (error) {
    await db.outboundMessage.update({
      where: { id: m.id },
      data: { status: "FAILED", heldReason: "The email provider did not accept the message." },
    });
    await writeAudit({
      workspaceId: ctx.workspaceId,
      actorType: "SYSTEM",
      action: "outbound.failed",
      targetType: "OutboundMessage",
      targetId: m.id,
      summary: "The email provider did not accept the message",
    });
    throw error;
  }

  await db.$tenantTransaction(async (tx) => {
    await tx.outboundMessage.update({
      where: { id: m.id },
      data: { status: "SENT", sentAt: now, providerMessageId, transport: transport.name },
    });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: "SYSTEM",
        action: "outbound.sent",
        targetType: "OutboundMessage",
        targetId: m.id,
        agentRunId: m.agentRunId,
        summary: `Sent to the customer through the ${transport.name} transport`,
        after: { providerMessageId, transport: transport.name, guardResults: results },
      },
      tx,
    );
  });
  return { status: "SENT", providerMessageId, transport: transport.name };
}
