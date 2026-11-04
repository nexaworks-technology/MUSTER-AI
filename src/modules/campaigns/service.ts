import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { CustomerTransport } from "@/lib/email/customerTransport";
import type { Actor } from "@/modules/accounts/service";
import { dispatch, type DispatchResult } from "@/modules/outbound/dispatch";
import { segmentWhere } from "@/modules/segments/service";
import { calculateRecipientSchedule } from "./pacing";
import { renderCampaignText } from "./render";
import { createUnsubscribeToken } from "./unsubscribe";

export const campaignInput = z.object({
  name: z.string().trim().min(1, "Name the campaign").max(120),
  segmentId: z.string().min(1, "Select a recipient segment"),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  body: z.string().trim().min(1, "Email body is required").max(10_000),
  pacePerHour: z.coerce.number().int().min(1).max(5000).default(100),
});

export type CreateCampaignInput = z.infer<typeof campaignInput>;

export async function listCampaigns(actor: Actor) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const campaigns = await db.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      segment: { select: { id: true, name: true } },
      approval: { select: { id: true, status: true, decidedById: true } },
      createdBy: { include: { user: { select: { name: true, email: true } } } },
      _count: {
        select: {
          recipients: true,
        },
      },
    },
  });

  return campaigns;
}

export async function getCampaign(actor: Actor, campaignId: string) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: {
      segment: true,
      approval: {
        include: {
          decidedBy: { include: { user: { select: { name: true, email: true } } } },
        },
      },
      createdBy: { include: { user: { select: { name: true, email: true } } } },
      recipients: {
        include: {
          contact: { select: { id: true, name: true, email: true } },
          account: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      },
      _count: {
        select: {
          recipients: true,
        },
      },
    },
  });

  const recipientCounts = await db.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { id: true },
  });

  const stats = {
    total: campaign._count.recipients,
    queued: 0,
    held: 0,
    sent: 0,
    failed: 0,
  };

  for (const group of recipientCounts) {
    if (group.status === "QUEUED") stats.queued = group._count.id;
    else if (group.status === "HELD") stats.held = group._count.id;
    else if (group.status === "SENT") stats.sent = group._count.id;
    else if (group.status === "FAILED") stats.failed = group._count.id;
  }

  return { ...campaign, stats };
}

export async function createCampaign(actor: Actor, raw: unknown) {
  requirePermission(actor, "plays:createDraft");
  const input = campaignInput.parse(raw);
  const db = scopedDb(actor);

  const seg = await segmentWhere(actor, input.segmentId);
  if (!seg) {
    throw new Error("Selected segment was not found or is invalid.");
  }

  // Find accounts matching segment
  const accounts = await db.account.findMany({
    where: seg.where,
    include: {
      contacts: {
        where: {
          status: "ACTIVE",
          email: { not: null },
        },
      },
    },
  });

  const recipientPairs: Array<{ accountId: string; contactId: string }> = [];
  for (const acct of accounts) {
    for (const c of acct.contacts) {
      recipientPairs.push({ accountId: acct.id, contactId: c.id });
    }
  }

  return await db.$tenantTransaction(async (tx) => {
    // 1. Create Approval row
    const approval = await tx.approval.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: null,
        kind: "CAMPAIGN",
        reason: `Campaign: ${input.name} ("${input.subject}")`,
        proof: [{ sourceType: "Segment", sourceId: input.segmentId }],
        requiredLevel: "DRAFT_FOR_APPROVAL",
      },
    });

    // 2. Create Campaign
    const campaign = await tx.campaign.create({
      data: {
        workspaceId: actor.workspaceId,
        name: input.name,
        segmentId: input.segmentId,
        subject: input.subject,
        body: input.body,
        pacePerHour: input.pacePerHour,
        status: "DRAFT",
        approvalId: approval.id,
        createdById: actor.membershipId,
      },
    });

    // 3. Create CampaignRecipients
    if (recipientPairs.length > 0) {
      await tx.campaignRecipient.createMany({
        data: recipientPairs.map((r) => ({
          workspaceId: actor.workspaceId,
          campaignId: campaign.id,
          contactId: r.contactId,
          accountId: r.accountId,
          status: "QUEUED",
        })),
        skipDuplicates: true,
      });
    }

    // 4. Audit
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "campaign.created",
        targetType: "Campaign",
        targetId: campaign.id,
        summary: `Created campaign "${input.name}" with ${recipientPairs.length} recipients`,
        after: {
          name: input.name,
          segmentId: input.segmentId,
          recipientsCount: recipientPairs.length,
          approvalId: approval.id,
        },
      },
      tx,
    );

    return campaign;
  });
}

export async function scheduleCampaign(
  actor: Actor,
  campaignId: string,
  scheduledAt: Date,
  options?: { clock?: () => Date },
) {
  requirePermission(actor, "plays:createDraft");
  const db = scopedDb(actor);

  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { approval: true },
  });

  if (!campaign.approval || (campaign.approval.status !== "APPROVED" && campaign.approval.status !== "EDITED_APPROVED")) {
    throw new ForbiddenError("Campaign cannot be scheduled until it has been approved by an Admin or CS Leader.");
  }

  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });

  const schedules = calculateRecipientSchedule({
    count: recipients.length,
    scheduledAt,
    pacePerHour: campaign.pacePerHour,
  });

  await db.$tenantTransaction(async (tx) => {
    for (let i = 0; i < recipients.length; i++) {
      const scheduledFor = schedules[i];
      await tx.campaignRecipient.update({
        where: { id: recipients[i].id },
        data: { scheduledFor },
      });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        scheduledAt,
        status: "SCHEDULED",
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "campaign.scheduled",
        targetType: "Campaign",
        targetId: campaignId,
        summary: `Scheduled campaign "${campaign.name}" for ${scheduledAt.toISOString()}`,
        after: { scheduledAt, pacePerHour: campaign.pacePerHour },
      },
      tx,
    );
  });

  return { scheduled: true, recipientCount: recipients.length };
}

export async function executeCampaignBatch(
  actor: Actor,
  campaignId: string,
  options?: {
    clock?: () => Date;
    transport?: CustomerTransport;
    limit?: number;
  },
): Promise<{
  processed: number;
  sent: number;
  held: number;
  failed: number;
  remainingQueued: number;
}> {
  const db = scopedDb(actor);
  const now = (options?.clock ?? (() => new Date()))();

  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { approval: true },
  });

  // Query QUEUED recipients scheduled up to now (or without scheduledFor if immediate)
  const recipients = await db.campaignRecipient.findMany({
    where: {
      campaignId,
      status: "QUEUED",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
    },
    include: {
      account: true,
      contact: true,
    },
    orderBy: { createdAt: "asc" },
    take: options?.limit ?? 50,
  });

  if (recipients.length === 0) {
    const remaining = await db.campaignRecipient.count({
      where: { campaignId, status: "QUEUED" },
    });
    if (remaining === 0) {
      await db.campaign.update({
        where: { id: campaignId },
        data: { status: "SENT" },
      });
    }
    return { processed: 0, sent: 0, held: 0, failed: 0, remainingQueued: remaining };
  }

  await db.campaign.update({
    where: { id: campaignId },
    data: { status: "SENDING" },
  });

  let sent = 0;
  let held = 0;
  let failed = 0;

  for (const recip of recipients) {
    if (!recip.contact.email) {
      await db.campaignRecipient.update({
        where: { id: recip.id },
        data: { status: "FAILED", heldReason: "Contact has no email address." },
      });
      failed++;
      continue;
    }

    const unsubToken = createUnsubscribeToken({
      workspaceId: actor.workspaceId,
      contactId: recip.contactId,
      email: recip.contact.email,
    });
    const unsubUrl = `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/unsubscribe?token=${unsubToken}`;

    const rawSubject = renderCampaignText(campaign.subject, {
      account: recip.account,
      contact: recip.contact,
    });
    const renderedBody = renderCampaignText(campaign.body, {
      account: recip.account,
      contact: recip.contact,
    });
    const fullBody = `${renderedBody}\n\n---\nTo unsubscribe: ${unsubUrl}`;

    try {
      // 1. Create OutboundMessage
      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: actor.workspaceId,
          accountId: recip.accountId,
          contactId: recip.contactId,
          toEmail: recip.contact.email,
          campaignId: campaign.id,
          sendMode: "CAMPAIGN",
          subject: rawSubject,
          bodyText: fullBody,
          status: "AWAITING_APPROVAL",
        },
      });

      // 2. Link OutboundMessage to recipient
      await db.campaignRecipient.update({
        where: { id: recip.id },
        data: { outboundMessageId: msg.id },
      });

      // 3. Dispatch through single send choke point
      const res: DispatchResult = await dispatch(actor, msg.id, {
        clock: options?.clock,
        transport: options?.transport,
      });

      if (res.status === "SENT") {
        sent++;
      } else if (res.status === "HELD") {
        held++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
    }
  }

  const remainingQueued = await db.campaignRecipient.count({
    where: { campaignId, status: "QUEUED" },
  });

  if (remainingQueued === 0) {
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: "SENT" },
    });
  }

  return {
    processed: recipients.length,
    sent,
    held,
    failed,
    remainingQueued,
  };
}
