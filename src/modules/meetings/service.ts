import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { Document } from "@prisma/client";
import { runAgent, type ExecutorDeps, type RunOutcome } from "../agents/executor";
import { meetingQbr } from "../agents/definitions/meeting-qbr";
import { watcher } from "../agents/definitions/watcher";

export interface PrepareBriefInput {
  meetingId: string;
  briefVersion?: number;
}

export interface SummarizeCallInput {
  accountId: string;
  meetingId?: string;
  transcriptId?: string;
}

/**
 * Prepares a pre-call brief for an upcoming meeting.
 * Idempotent per (meetingId, briefVersion): repeated runs produce 1 brief document.
 */
export async function prepareBrief(
  ctx: TenantContext,
  input: PrepareBriefInput,
  deps: ExecutorDeps = {},
): Promise<Document> {
  const db = scopedDb(ctx);
  const version = input.briefVersion ?? 1;

  // Check if brief document already exists for this meeting
  const meeting = await db.meeting.findUniqueOrThrow({
    where: { id: input.meetingId },
    include: { briefDocument: true },
  });

  if (meeting.briefDocument) {
    return meeting.briefDocument;
  }

  if (!meeting.accountId) {
    throw new Error(`Cannot prepare brief for meeting ${meeting.id}: meeting is not matched to an account.`);
  }

  const outcome = await runAgent(
    ctx,
    meetingQbr,
    {
      action: "PREPARE_BRIEF",
      accountId: meeting.accountId,
      meetingId: meeting.id,
      briefVersion: version,
    },
    {
      type: "meetings.prepareBrief",
      id: `${meeting.id}:v${version}`,
    },
    deps,
  );

  if (outcome.kind !== "run" || outcome.status !== "SUCCEEDED") {
    throw new Error(`Failed to generate brief for meeting ${meeting.id}: ${outcome.kind}`);
  }

  const updated = await db.meeting.findUniqueOrThrow({
    where: { id: input.meetingId },
    include: { briefDocument: true },
  });

  if (!updated.briefDocument) {
    throw new Error(`Brief document was not created for meeting ${meeting.id}`);
  }

  return updated.briefDocument;
}

/**
 * Summarizes a call transcript, generates action items with Task handoff,
 * and routes the transcript to the Watcher extraction pipeline.
 */
export async function summarizeCall(
  ctx: TenantContext,
  input: SummarizeCallInput,
  deps: ExecutorDeps = {},
): Promise<RunOutcome> {
  const outcome = await runAgent(
    ctx,
    meetingQbr,
    {
      action: "SUMMARIZE_CALL",
      accountId: input.accountId,
      meetingId: input.meetingId,
      transcriptId: input.transcriptId,
    },
    {
      type: "meetings.summarize",
      id: input.transcriptId ?? input.meetingId ?? input.accountId,
    },
    deps,
  );

  // Extraction handoff: route transcript to Watcher extraction pipeline
  if (input.transcriptId) {
    try {
      await runAgent(
        ctx,
        watcher,
        {
          sourceType: "CALL_TRANSCRIPT",
          sourceId: input.transcriptId,
          chunkIndex: 0,
        },
        {
          type: "extraction",
          id: `transcript:${input.transcriptId}:chunk:0`,
        },
        deps,
      );
    } catch {
      // Non-fatal: extraction pipeline errors do not abort call summary
    }
  }

  return outcome;
}
