import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";

export interface CaptureVoiceSampleInput {
  outboundMessageId?: string;
  subject: string;
  bodyText: string;
}

export class VoiceSampleNotFoundError extends Error {
  constructor(message = "Voice sample not found") {
    super(message);
    this.name = "VoiceSampleNotFoundError";
  }
}

export async function listVoiceSamples(actor: Actor) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  return db.voiceSample.findMany({
    where: { workspaceId: actor.workspaceId, approvedForVoice: true },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { include: { user: { select: { name: true, email: true } } } },
      outboundMessage: { select: { id: true, subject: true, sentAt: true } },
    },
  });
}

export async function captureVoiceSample(
  actor: Actor,
  input: CaptureVoiceSampleInput,
) {
  requirePermission(actor, "workspace:manageSettings");
  const db = scopedDb(actor);

  if (input.outboundMessageId) {
    const msg = await db.outboundMessage.findUnique({
      where: { id: input.outboundMessageId },
    });
    if (!msg) {
      throw new Error("Outbound message not found in this workspace.");
    }
  }

  return db.$tenantTransaction(async (tx) => {
    const sample = await tx.voiceSample.create({
      data: {
        workspaceId: actor.workspaceId,
        outboundMessageId: input.outboundMessageId ?? null,
        subject: input.subject,
        bodyText: input.bodyText,
        approvedForVoice: true,
        createdById: actor.membershipId,
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "voice_sample.captured",
        targetType: "VoiceSample",
        targetId: sample.id,
        summary: `Captured voice sample "${sample.subject}"`,
        after: {
          outboundMessageId: sample.outboundMessageId,
          subject: sample.subject,
        },
      },
      tx,
    );

    return sample;
  });
}

export async function removeVoiceSample(actor: Actor, sampleId: string) {
  requirePermission(actor, "workspace:manageSettings");
  const db = scopedDb(actor);

  const sample = await db.voiceSample.findUnique({
    where: { id: sampleId },
  });
  if (!sample) throw new VoiceSampleNotFoundError();

  return db.$tenantTransaction(async (tx) => {
    const updated = await tx.voiceSample.update({
      where: { id: sampleId },
      data: { approvedForVoice: false },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "voice_sample.removed",
        targetType: "VoiceSample",
        targetId: sample.id,
        summary: `Removed voice sample "${sample.subject}"`,
      },
      tx,
    );

    return updated;
  });
}
