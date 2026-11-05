import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { defineAgent, type BuiltContext, type Effect } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";

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

export const meetingQbrOutput = z.object({
  ...baseAgentOutput.shape,
  title: z.string().min(1).max(500).default("Meeting Brief"),
  summary: z.string().min(1).max(4000).default("Summary"),
  decisions: z.array(z.string()).default([]),
  actionItems: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        description: z.string().default(""),
        assigneeEmail: z.string().nullable().optional(),
        dueDate: z.string().nullable().optional(),
      }),
    )
    .default([]),
  suggestedQuestions: z.array(z.string()).default([]),
  healthHighlights: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  narrative: z.array(z.unknown()).default([]),
});
export type MeetingQbrOutput = z.infer<typeof meetingQbrOutput>;

export const meetingQbr = defineAgent({
  key: "meeting-qbr",
  version: "1.0.0",
  description:
    "Prepares pre-call briefs, meeting summaries with action item handoffs, and QBR narrative blocks",
  modelTier: "standard",
  tierReason:
    "High-utility briefings and accurate conversation summaries require standard tone and precision.",
  prompt: { name: "meeting-brief", version: "1.0.0" },
  forbiddenNumericFields: [],
  approvalPolicy: "INTERNAL",
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

      // Latest health snapshot
      const snapshot = await db.healthScoreSnapshot.findFirst({
        where: { accountId: input.accountId },
        orderBy: { asOf: "desc" },
        include: { riskReason: true },
      });
      if (snapshot) {
        bundle.push({
          sourceType: "HealthScoreSnapshot",
          sourceId: snapshot.id,
          fields: {
            overall: snapshot.overall ? Number(snapshot.overall) : null,
            riskLevel: snapshot.riskLevel,
            riskReason: snapshot.riskReason?.message ?? null,
          },
        });
      }

      // Active contract
      const contract = await db.contract.findFirst({
        where: { accountId: input.accountId, status: "ACTIVE" },
        orderBy: { startDate: "desc" },
      });
      if (contract) {
        bundle.push({
          sourceType: "Contract",
          sourceId: contract.id,
          fields: {
            status: contract.status,
            renewalDate: contract.renewalDate?.toISOString().slice(0, 10) ?? null,
          },
        });
      }

      // Open promises
      const promises = await db.promise.findMany({
        where: { accountId: input.accountId, status: { in: ["OPEN", "LATE", "BROKEN"] } },
        take: 5,
      });
      for (const p of promises) {
        bundle.push({
          sourceType: "Promise",
          sourceId: p.id,
          fields: {
            what: p.what,
            status: p.status,
          },
        });
      }

      return {
        bundle,
        vars: {
          csmName,
          accountName,
          meetingTitle,
        },
        accountId: input.accountId,
        prompt: { name: "meeting-brief", version: "1.0.0" },
        tier: "standard",
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
        tier: "standard",
      };
    }

    // QBR_NARRATIVE
    return {
      bundle,
      vars: {
        accountName,
        periodLabel: input.qbrPeriod ?? "Current Quarter",
      },
      accountId: input.accountId,
      prompt: { name: "qbr-narrative", version: "1.0.0" },
      tier: "deep",
    };
  },

  async act(output, ctx) {
    const input = meetingQbrInput.parse(ctx.input);
    const db = ctx.db;

    if (input.action === "PREPARE_BRIEF") {
      const narrativeJson = (
        output.narrative.length
          ? output.narrative
          : [
              { type: "summary", text: output.summary },
              { type: "health", items: output.healthHighlights },
              { type: "questions", items: output.suggestedQuestions },
            ]
      ) as Prisma.InputJsonValue;

      const doc = await db.document.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId!,
          kind: "PRE_CALL_BRIEF",
          title: output.title,
          metrics: (output.metrics ?? {}) as Prisma.InputJsonValue,
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
