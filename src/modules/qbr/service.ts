import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { liveSnapshotWhere } from "@/modules/health/service";
import type { Prisma, Document } from "@prisma/client";
import { runAgent, type ExecutorDeps } from "../agents/executor";
import { meetingQbr } from "../agents/definitions/meeting-qbr";
import { computeQbrMetrics, validateNarrativeText, validatePeriodLabel } from "./metrics";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { writeAudit } from "@/lib/audit";
import { recordProductEvent } from "@/lib/pilot/capture";

export interface QbrBlock {
  id: string;
  type: string;
  title: string;
  text: string;
}

export interface QbrDocumentView extends Document {
  locked: boolean;
  body: {
    period: string;
    metrics: unknown;
    blocks: QbrBlock[];
  };
}

export interface GenerateQbrInput {
  accountId: string;
  period: string;
  canViewRevenue?: boolean;
}

function toQbrView(doc: Document): QbrDocumentView {
  const metricsData = (doc.metrics as Record<string, unknown>) ?? {};
  const narrativeData = Array.isArray(doc.narrative)
    ? (doc.narrative as unknown as QbrBlock[])
    : [];

  const period = typeof metricsData.period === "string" ? metricsData.period : "QBR Period";
  const metrics = metricsData.computed ?? metricsData;

  return {
    ...doc,
    locked: doc.lockedAt !== null,
    body: {
      period,
      metrics,
      blocks: narrativeData,
    },
  };
}

/**
 * Generates a QBR document for an account over a specified period.
 * 1. Validates period against the closed allowlist (e.g. "Q3 2026").
 * 2. Computes locked metrics via pure computation.
 * 3. Runs meetingQbr agent to generate narrative blocks.
 * 4. Stores locked metrics and narrative blocks in Document.
 */
export async function generateQbr(
  ctx: TenantContext & { membershipId?: string; canViewRevenue?: boolean },
  input: GenerateQbrInput,
  deps: ExecutorDeps = {},
): Promise<QbrDocumentView> {
  const db = scopedDb(ctx);

  // Validate period label
  const periodValidation = validatePeriodLabel(input.period);
  if (!periodValidation.valid) {
    throw new Error(periodValidation.error);
  }
  const period = periodValidation.value;

  // Load account and dependencies for metrics
  const account = await db.account.findUniqueOrThrow({
    where: { id: input.accountId },
    select: { id: true, name: true, arrMinor: true, arrCurrency: true },
  });

  const [snapshot, contract, usage, promises, tickets] = await Promise.all([
    db.healthScoreSnapshot.findFirst({
      where: liveSnapshotWhere({ accountId: input.accountId }),
      orderBy: { asOf: "desc" },
    }),
    db.contract.findFirst({
      where: { accountId: input.accountId, status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    }),
    db.usageDaily.findMany({
      where: { accountId: input.accountId },
      orderBy: { date: "desc" },
      take: 30,
      select: { date: true, seatsUsed: true },
    }),
    db.promise.findMany({
      where: { accountId: input.accountId },
      select: { status: true },
    }),
    db.ticket.findMany({
      where: { accountId: input.accountId },
      select: { id: true },
    }),
  ]);

  const canViewRevenue = input.canViewRevenue ?? ctx.canViewRevenue ?? true;

  const metrics = computeQbrMetrics({
    account,
    healthSnapshot: snapshot
      ? {
          overall: snapshot.overall ? Number(snapshot.overall) : null,
          riskLevel: snapshot.riskLevel,
          adoption: snapshot.adoption ? Number(snapshot.adoption) : null,
          engagement: snapshot.engagement ? Number(snapshot.engagement) : null,
          support: snapshot.support ? Number(snapshot.support) : null,
          relationship: snapshot.relationship ? Number(snapshot.relationship) : null,
          commercial: snapshot.commercial ? Number(snapshot.commercial) : null,
          sentiment: snapshot.sentiment ? Number(snapshot.sentiment) : null,
        }
      : null,
    contract,
    usage,
    promises,
    tickets,
    canViewRevenue,
  });

  // Run AI agent for narrative
  const outcome = await runAgent(
    ctx,
    meetingQbr,
    {
      action: "QBR_NARRATIVE",
      accountId: input.accountId,
      qbrPeriod: period,
    },
    {
      type: "qbr.generate",
      id: `${input.accountId}:${period}`,
    },
    deps,
  );

  if (outcome.kind !== "run" || outcome.status !== "SUCCEEDED") {
    throw new Error(`Failed to generate QBR narrative: ${outcome.kind}`);
  }

  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: outcome.runId },
  });

  const agentOutput =
    (run.output as {
      title?: string;
      summary?: string;
      decisions?: string[];
      actionItems?: Array<{ title: string; ownerName?: string }>;
    }) ?? {};

  const initialBlocks: QbrBlock[] = [
    {
      id: "b1",
      type: "executive_summary",
      title: "Executive Summary",
      text: agentOutput.summary ?? "Executive review for the period.",
    },
    {
      id: "b2",
      type: "business_outcomes",
      title: "Business Outcomes & Decisions",
      text:
        (agentOutput.decisions ?? []).length > 0
          ? agentOutput.decisions!.join("\n")
          : "All primary milestones achieved in accordance with agreed schedule.",
    },
    {
      id: "b3",
      type: "action_items",
      title: "Action Items & Mutual Plan",
      text:
        (agentOutput.actionItems ?? []).map((a) => `- ${a.title}`).join("\n") ||
        "No open action items pending.",
    },
  ];

  // Validate initial blocks
  for (const block of initialBlocks) {
    const val = validateNarrativeText(block.text);
    if (!val.valid) {
      throw new Error(`Agent generated invalid narrative block: ${val.violations.join("; ")}`);
    }
  }

  const doc = await db.document.create({
    data: {
      workspaceId: ctx.workspaceId,
      accountId: input.accountId,
      kind: "QBR",
      title: agentOutput.title ?? `${period} Executive Business Review`,
      origin: "AI",
      agentRunId: outcome.runId,
      metrics: {
        period,
        computed: metrics,
      },
      narrative: initialBlocks as unknown as Prisma.InputJsonValue,
      lockedAt: null,
    },
  });

  await recordProductEvent(ctx, {
    name: "qbr.generated",
    subjectType: "Document",
    subjectId: doc.id,
  });

  return toQbrView(doc);
}

/**
 * Updates narrative blocks in an unlocked QBR document.
 * Enforces text-only validation: blocks cannot contain raw currency or metric numbers.
 * The locked metrics payload is never altered.
 */
export async function updateQbrNarrative(
  ctx: TenantContext,
  documentId: string,
  blocks: QbrBlock[],
): Promise<QbrDocumentView> {
  const db = scopedDb(ctx);
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
  });

  if (doc.lockedAt !== null) {
    throw new Error(`Document ${documentId} is locked and cannot be edited.`);
  }

  // Validate each block
  for (const b of blocks) {
    const val = validateNarrativeText(b.text);
    if (!val.valid) {
      throw new Error(val.violations.join("; "));
    }
  }

  const updated = await db.document.update({
    where: { id: documentId },
    data: {
      narrative: blocks as unknown as Prisma.InputJsonValue,
    },
  });

  return toQbrView(updated);
}

/**
 * Locks a QBR document.
 * Sets lockedAt timestamp, preventing any further narrative edits.
 * Emits outbox event `business_review.followup` for play waking.
 */
export async function lockQbrDocument(
  ctx: TenantContext & { membershipId?: string },
  documentId: string,
): Promise<QbrDocumentView> {
  const db = scopedDb(ctx);
  let newlyLocked = false;

  const updated = await db.$tenantTransaction(async (tx) => {
    const doc = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
    });

    if (doc.lockedAt !== null) {
      return doc;
    }

    const locked = await tx.document.update({
      where: { id: documentId },
      data: { lockedAt: new Date() },
    });
    newlyLocked = true;

    await writeOutboxEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: "business_review.followup",
      payload: {
        workspaceId: ctx.workspaceId,
        documentId: locked.id,
        accountId: locked.accountId,
      },
    });

    if (ctx.membershipId) {
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "USER",
          actorId: ctx.membershipId,
          action: "document.locked",
          targetType: "Document",
          targetId: locked.id,
          summary: `Locked QBR document "${locked.title}"`,
        },
        tx,
      );
    }

    return locked;
  });

  // Locking publishes the QBR to the customer portal: that is the "shared" end of prep time.
  if (newlyLocked)
    await recordProductEvent(ctx, {
      name: "qbr.shared",
      subjectType: "Document",
      subjectId: updated.id,
    });

  return toQbrView(updated);
}

/**
 * Exports QBR as a PDF document representation.
 */
export async function exportQbrPdf(
  ctx: TenantContext,
  documentId: string,
): Promise<{ filename: string; mimeType: "application/pdf"; buffer: Buffer }> {
  const db = scopedDb(ctx);
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
  });

  const view = toQbrView(doc);
  const title = view.title.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${title}.pdf`;

  // Standard mock/minimal PDF header
  const fakePdfContent = `%PDF-1.4\n1 0 obj\n<< /Title (${view.title}) /Period (${view.body.period}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`;
  const buffer = Buffer.from(fakePdfContent, "utf-8");

  return {
    filename,
    mimeType: "application/pdf",
    buffer,
  };
}
