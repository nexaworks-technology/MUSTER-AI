import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { Document, Prisma } from "@prisma/client";
import { runAgent, type ExecutorDeps, type RunOutcome } from "../agents/executor";
import { meetingQbr } from "../agents/definitions/meeting-qbr";
import { watcher } from "../agents/definitions/watcher";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { recordProductEvent } from "@/lib/pilot/capture";

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
  ctx: TenantContext & { membershipId?: string },
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
    throw new Error(
      `Cannot prepare brief for meeting ${meeting.id}: meeting is not matched to an account.`,
    );
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

  // Only a person who asked for the brief counts toward prep time; the worker's sweep has no member.
  await recordProductEvent(ctx, {
    name: "brief.generated",
    subjectType: "Document",
    subjectId: updated.briefDocument.id,
    props: { kind: "PRE_CALL_BRIEF" },
  });

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

/**
 * Schedules an outbox event to generate a pre-call brief at T-30 minutes before meeting startsAt.
 */
export async function scheduleBriefForMeeting(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  meeting: { id: string; startsAt: Date; accountId?: string | null },
) {
  if (!meeting.accountId) return null;
  const leadMs = 30 * 60 * 1000;
  const availableAt = new Date(Math.max(Date.now(), meeting.startsAt.getTime() - leadMs));
  return writeOutboxEvent(tx, {
    workspaceId,
    type: "meetings.prepareBrief",
    payload: { workspaceId, meetingId: meeting.id },
    availableAt,
  });
}

/**
 * Sweep for upcoming meetings in a workspace starting in the next 45 minutes with no brief document.
 */
export async function sweepUpcomingMeetingBriefs(
  ctx: TenantContext,
  now = new Date(),
  deps: ExecutorDeps = {},
): Promise<number> {
  const db = scopedDb(ctx);
  const in45m = new Date(now.getTime() + 45 * 60 * 1000);
  const upcoming = await db.meeting.findMany({
    where: {
      status: "SCHEDULED",
      accountId: { not: null },
      briefDocumentId: null,
      startsAt: { gte: now, lte: in45m },
    },
    select: { id: true },
  });

  let prepared = 0;
  for (const m of upcoming) {
    try {
      await prepareBrief(ctx, { meetingId: m.id }, deps);
      prepared++;
    } catch {
      // continues sweep on individual error
    }
  }
  return prepared;
}

export async function sweepAllUpcomingMeetingBriefs(
  deps: ExecutorDeps = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const w of await listActiveWorkspaces()) {
    out[w.slug] = await sweepUpcomingMeetingBriefs({ workspaceId: w.id }, new Date(), deps);
  }
  return out;
}

// The Meetings & QBRs screen's read side (FIX-2026-11-11), kept in its own file and re-exported here.
export {
  listMeetingsIndex,
  MEETINGS_INDEX_LIMIT,
  type MeetingIndexRow,
  type MeetingsIndex,
  type QbrIndexRow,
} from "./list";
