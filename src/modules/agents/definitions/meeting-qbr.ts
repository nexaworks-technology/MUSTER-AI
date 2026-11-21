import { z } from "zod";
import { liveSnapshotWhere } from "@/modules/health/service";
import type { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";
import { defineAgent, type BuiltContext, type Effect } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

export const meetingQbrInput = z.object({
  action: z.enum(["PREPARE_BRIEF", "SUMMARIZE_CALL", "QBR_NARRATIVE"]).default("PREPARE_BRIEF"),
  accountId: z.string().min(1),
  meetingId: z.string().optional(),
  transcriptId: z.string().optional(),
  briefVersion: z.number().int().positive().default(1),
  qbrPeriod: z.string().optional(),
  nonce: z.string().optional(),
});
export type MeetingQbrInput = z.infer<typeof meetingQbrInput>;

/**
 * Every node is typed: the live provider rejects an untyped JSON-schema node, and `z.unknown()`
 * becomes one (DEMO-WALKTHROUGH FAIL 34/35). No title and no metrics: the document title is built
 * from the meeting or the period, and figures live in the locked metrics, never in model output
 * (D-75).
 */
const lines = z.array(z.string().min(1).max(1_000)).max(12).default([]);
export const meetingQbrOutput = z.object({
  ...baseAgentOutput.shape,
  summary: z.string().min(1).max(4000),
  decisions: lines,
  actionItems: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(2_000).default(""),
        assigneeEmail: z.string().nullable().default(null),
        dueDate: z.string().nullable().default(null),
      }),
    )
    .max(20)
    .default([]),
  suggestedQuestions: lines,
  healthHighlights: lines,
  recentActivity: lines,
  openItems: lines,
});
export type MeetingQbrOutput = z.infer<typeof meetingQbrOutput>;

export const meetingQbr = defineAgent({
  key: "meeting-qbr",
  version: "1.1.0",
  description:
    "Prepares pre-call briefs, meeting summaries with action item handoffs, and QBR narrative blocks",
  modelTier: jobTier("meeting-qbr"),
  tierReason:
    "High-utility briefings and accurate conversation summaries require standard tone and precision.",
  prompt: { name: "meeting-brief", version: "1.1.0" },
  forbiddenNumericFields: [],
  approvalPolicy: "INTERNAL",
  // Every number the model writes must be in a record it cites (Rule 1, D-75).
  narrative: (o) => [
    o.summary,
    ...o.decisions,
    ...o.actionItems.flatMap((a) => [a.title, a.description]),
    ...o.suggestedQuestions,
    ...o.healthHighlights,
    ...o.recentActivity,
    ...o.openItems,
  ],
  inputSchema: meetingQbrInput,
  outputSchema: meetingQbrOutput,

  async buildContext(db, input, _ctx): Promise<BuiltContext> {
    const account = await db.account.findUnique({
      where: { id: input.accountId },
      select: {
        id: true,
        name: true,
        owner: {
          select: { user: { select: { name: true } } },
        },
      },
    });

    const accountName = account?.name ?? "the account";
    const csmName = account?.owner?.user?.name ?? "the CSM";
    const bundle: ContextBundle = [];

    if (account) {
      bundle.push({
        sourceType: "Account",
        sourceId: account.id,
        fields: {
          name: account.name,
        },
      });
    }

    if (input.action === "PREPARE_BRIEF") {
      let meetingTitle = "Upcoming Meeting";
      if (input.meetingId) {
        const meeting = await db.meeting.findUnique({
          where: { id: input.meetingId },
          include: { attendees: true },
        });
        if (meeting) {
          meetingTitle = meeting.title;
          bundle.push({
            sourceType: "Meeting",
            sourceId: meeting.id,
            fields: {
              title: meeting.title,
              startsAt: meeting.startsAt.toISOString(),
              attendeesCount: meeting.attendees.length,
            },
          });
        }
      }

      bundle.push(...(await accountRecords(db, input.accountId)));

      return {
        bundle,
        vars: {
          csmName,
          accountName,
          meetingTitle,
        },
        accountId: input.accountId,
        prompt: { name: "meeting-brief", version: "1.1.0" },
        tier: jobTier("meeting-brief"),
      };
    }

    if (input.action === "SUMMARIZE_CALL") {
      let meetingTitle = "Call Transcript";
      if (input.transcriptId) {
        const t = await db.callTranscript.findUnique({
          where: { id: input.transcriptId },
        });
        if (t) {
          meetingTitle = t.title;
          bundle.push({
            sourceType: "CallTranscript",
            sourceId: t.id,
            fields: {
              title: t.title,
              text: t.text,
            },
          });
        }
      } else if (input.meetingId) {
        const meeting = await db.meeting.findUnique({
          where: { id: input.meetingId },
          include: { conversation: { include: { transcripts: true } } },
        });
        if (meeting) {
          meetingTitle = meeting.title;
          const transcript = meeting.conversation?.transcripts[0];
          if (transcript) {
            bundle.push({
              sourceType: "CallTranscript",
              sourceId: transcript.id,
              fields: {
                title: transcript.title,
                text: transcript.text,
              },
            });
          }
        }
      }

      return {
        bundle,
        vars: {
          accountName,
          meetingTitle,
        },
        accountId: input.accountId,
        prompt: { name: "meeting-summary", version: "1.0.0" },
        tier: jobTier("meeting-summary"),
      };
    }

    // QBR_NARRATIVE: the records the review may speak to; the figures are in the locked metrics.
    // The period is a record too, so a narrative that names it ("Q4 2026") can cite where that came
    // from instead of being refused for a numeral no record holds.
    bundle.push({
      sourceType: "QbrPeriod",
      sourceId: input.qbrPeriod ?? "current",
      fields: { period: input.qbrPeriod ?? "Current Quarter" },
    });
    bundle.push(...(await accountRecords(db, input.accountId)));
    return {
      bundle,
      vars: {
        accountName,
        periodLabel: input.qbrPeriod ?? "Current Quarter",
      },
      accountId: input.accountId,
      prompt: { name: "qbr-narrative", version: "1.1.0" },
      tier: jobTier("qbr-narrative"),
    };
  },

  async act(output, ctx) {
    const input = meetingQbrInput.parse(ctx.input);
    const db = ctx.db;

    if (input.action === "PREPARE_BRIEF") {
      const meeting = input.meetingId
        ? await db.meeting.findUnique({ where: { id: input.meetingId }, select: { title: true } })
        : null;
      const narrativeJson = [
        { type: "summary", text: output.summary },
        { type: "health", items: output.healthHighlights },
        { type: "activity", items: output.recentActivity },
        { type: "open_items", items: output.openItems },
        { type: "questions", items: output.suggestedQuestions },
      ] satisfies Prisma.InputJsonValue;

      const doc = await db.document.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId!,
          kind: "PRE_CALL_BRIEF",
          title: `Pre-call Brief: ${meeting?.title ?? "Upcoming meeting"}`,
          narrative: narrativeJson,
          origin: "AI",
          agentRunId: ctx.runId,
        },
      });

      if (input.meetingId) {
        await db.meeting.update({
          where: { id: input.meetingId },
          data: { briefDocumentId: doc.id },
        });
      }

      return {
        effects: [{ type: "Document", id: doc.id }],
        actionTaken: "EXECUTED",
      };
    }

    if (input.action === "SUMMARIZE_CALL") {
      if (input.meetingId) {
        await db.meeting.update({
          where: { id: input.meetingId },
          data: { summaryAgentRunId: ctx.runId },
        });
      }

      const effects: Effect[] = [];
      for (const item of output.actionItems) {
        let ownerMembershipId: string | null = null;
        let title = item.title;

        if (item.assigneeEmail) {
          const emailLower = item.assigneeEmail.toLowerCase().trim();
          const member = await db.membership.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              status: "ACTIVE",
              user: { email: { equals: emailLower, mode: "insensitive" } },
            },
            select: { id: true },
          });
          if (member) {
            ownerMembershipId = member.id;
          }
        }

        if (!ownerMembershipId) {
          title = `[No owner found] ${item.title}`;
        }

        const task = await db.task.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: ctx.accountId,
            title,
            detail: item.description,
            ownerMembershipId,
            dueAt: item.dueDate ? new Date(item.dueDate) : null,
            origin: "AI",
            agentRunId: ctx.runId,
            source: "SYSTEM",
          },
        });

        effects.push({ type: "Task", id: task.id });
      }

      return {
        effects,
        actionTaken: effects.length > 0 ? "TASK_CREATED" : "NONE",
      };
    }

    return {
      effects: [],
      actionTaken: "NONE",
    };
  },
});


/** Health, contract, plan goals, open promises and open tickets: what a brief or review cites. */
async function accountRecords(db: ScopedDb, accountId: string): Promise<ContextBundle> {
  const [snapshot, contract, goals, promises, tickets] = await Promise.all([
    db.healthScoreSnapshot.findFirst({
      where: liveSnapshotWhere({ accountId }),
      orderBy: { asOf: "desc" },
      include: { riskReason: true },
    }),
    db.contract.findFirst({
      where: { accountId, status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    }),
    db.goal.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: { id: true, text: true, status: true, successPlan: { select: { title: true } } },
    }),
    db.promise.findMany({
      where: { accountId, status: { in: ["OPEN", "LATE", "BROKEN"] } },
      take: 5,
    }),
    db.ticket.findMany({
      where: { accountId, status: { notIn: ["SOLVED", "CLOSED"] } },
      orderBy: { openedAt: "desc" },
      take: 5,
      select: { id: true, subject: true, status: true, priority: true, openedAt: true },
    }),
  ]);
  const out: ContextBundle = [];
  if (snapshot)
    out.push({
      sourceType: "HealthScoreSnapshot",
      sourceId: snapshot.id,
      fields: {
        overall: snapshot.overall ? Number(snapshot.overall) : null,
        riskLevel: snapshot.riskLevel,
        riskReason: snapshot.riskReason?.message ?? null,
      },
    });
  if (contract)
    out.push({
      sourceType: "Contract",
      sourceId: contract.id,
      fields: {
        status: contract.status,
        renewalDate: contract.renewalDate?.toISOString().slice(0, 10) ?? null,
      },
    });
  for (const g of goals)
    out.push({
      sourceType: "Goal",
      sourceId: g.id,
      fields: { goal: g.text, status: g.status, plan: g.successPlan?.title ?? null },
    });
  for (const p of promises)
    out.push({ sourceType: "Promise", sourceId: p.id, fields: { what: p.what, status: p.status } });
  for (const t of tickets)
    out.push({
      sourceType: "Ticket",
      sourceId: t.id,
      fields: {
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        openedAt: t.openedAt.toISOString().slice(0, 10),
      },
    });
  return out;
}
