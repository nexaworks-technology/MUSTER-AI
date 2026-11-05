import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { summarizeCall } from "../service";

function createSummaryProvider(accountId: string, transcriptId: string, csmEmail: string): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>() {
      return {
        output: {
          reasoningSummary: "Analyzed call transcript and extracted decisions and actions.",
          confidence: 0.95,
          citations: [
            { sourceType: "Account", sourceId: accountId },
            { sourceType: "CallTranscript", sourceId: transcriptId },
          ],
          proposedActions: [],
          title: "Executive Sync Summary",
          summary: "Reviewed Q4 milestones and agreed on integration next steps.",
          decisions: ["Agreed to finalize API v2 integration by next Friday."],
          actionItems: [
            {
              title: "Update API endpoint configuration",
              description: "Configure webhook URLs in production environment.",
              assigneeEmail: csmEmail,
              dueDate: "2026-11-20T00:00:00Z",
            },
            {
              title: "Send vendor security questionnaire",
              description: "External client compliance review request.",
              assigneeEmail: "client@external.test",
              dueDate: null,
            },
            {
              title: "Review shipment webhook latency",
              description: "Unassigned investigation item.",
              assigneeEmail: null,
              dueDate: null,
            },
          ],
          suggestedQuestions: [],
          healthHighlights: [],
          metrics: {},
          narrative: [],
        } as T,
        stopReason: "end_turn",
        model: "recorded",
        requestId: null,
        inputTokens: 15,
        outputTokens: 35,
        latencyMs: 8,
      };
    },
  };
}

describe("Call summaries & action items handoff", () => {
  it("creates Tasks with owners; an unknown owner becomes an unassigned task with a 'No owner found' label, never an invented owner", async () => {
    const { actor: admin } = await createTestAdmin("summary-actions");
    const db = scopedDb(admin);

    // 1. Create known account and an internal team member with email csm@larkspur.test
    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Acme Logistics",
        tier: "HIGH_TOUCH",
      },
    });

    const csmEmail = `csm-summary-${Date.now()}@larkspur.test`;
    const csmUser = await db.user.create({
      data: {
        email: csmEmail,
        name: "Leo Marsh",
      },
    });

    const csmMembership = await db.membership.create({
      data: {
        workspaceId: admin.workspaceId,
        userId: csmUser.id,
        role: "CSM",
      },
    });

    const meeting = await db.meeting.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        title: "Acme Milestone Review",
        startsAt: new Date("2026-11-12T10:00:00Z"),
        endsAt: new Date("2026-11-12T11:00:00Z"),
        status: "COMPLETED",
      },
    });

    const conv = await db.conversation.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        channel: "CALL",
        subject: "Acme Milestone Review Call",
        startedAt: new Date("2026-11-12T10:00:00Z"),
        lastMessageAt: new Date("2026-11-12T11:00:00Z"),
      },
    });

    const transcript = await db.callTranscript.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        conversationId: conv.id,
        title: "Acme Milestone Review Transcript",
        provider: "FIREFLIES",
        occurredAt: new Date("2026-11-12T10:00:00Z"),
        text: "Leo: We will update the API endpoint configuration. Client: We will send our security questionnaire.",
      },
    });

    const provider = createSummaryProvider(account.id, transcript.id, csmEmail);

    // 2. Run summarizeCall
    const outcome = await summarizeCall(
      admin,
      {
        accountId: account.id,
        meetingId: meeting.id,
        transcriptId: transcript.id,
      },
      { provider },
    );

    expect(outcome.kind).toBe("run");
    if (outcome.kind !== "run") return;
    expect(outcome.status).toBe("SUCCEEDED");

    // 3. Verify meeting is updated with summaryAgentRunId
    const updatedMeeting = await db.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
    });
    expect(updatedMeeting.summaryAgentRunId).toBe(outcome.runId);

    // 4. Verify Tasks created
    const tasks = await db.task.findMany({
      where: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
      },
      orderBy: { createdAt: "asc" },
    });

    expect(tasks).toHaveLength(3);

    // Task 1: matched to internal CSM membership
    const task1 = tasks.find((t) => t.title === "Update API endpoint configuration")!;
    expect(task1).toBeDefined();
    expect(task1.ownerMembershipId).toBe(csmMembership.id);
    expect(task1.origin).toBe("AI");
    expect(task1.agentRunId).toBe(outcome.runId);

    // Task 2: unknown/external owner -> unassigned task with "No owner found" label, NEVER an invented owner
    const task2 = tasks.find((t) => t.title.includes("Send vendor security questionnaire"))!;
    expect(task2).toBeDefined();
    expect(task2.ownerMembershipId).toBeNull();
    expect(task2.title).toBe("[No owner found] Send vendor security questionnaire");
    expect(task2.origin).toBe("AI");
    expect(task2.agentRunId).toBe(outcome.runId);

    // Task 3: no assignee listed -> unassigned task with "No owner found" label, NEVER an invented owner
    const task3 = tasks.find((t) => t.title.includes("Review shipment webhook latency"))!;
    expect(task3).toBeDefined();
    expect(task3.ownerMembershipId).toBeNull();
    expect(task3.title).toBe("[No owner found] Review shipment webhook latency");
    expect(task3.origin).toBe("AI");
    expect(task3.agentRunId).toBe(outcome.runId);
  });
});
