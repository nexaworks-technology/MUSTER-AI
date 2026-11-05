import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { prepareBrief } from "../service";

const makeMockProvider = (accountId: string): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: {
        reasoningSummary: "Prepared brief from meeting details and account health.",
        confidence: 0.9,
        citations: [{ sourceType: "Account", sourceId: accountId }],
        proposedActions: [],
        title: "Pre-call Brief: Brightwell Executive Catchup",
        summary: "Brightwell Logistics is preparing for Q4 renewal with healthy usage.",
        decisions: [],
        actionItems: [],
        suggestedQuestions: [
          "How are the recent webhook integrations performing?",
          "Are there any blockers for the upcoming renewal?",
        ],
        healthHighlights: ["Overall health is at 88 (Good)"],
        metrics: { overallHealth: 88, band: "GOOD" },
        narrative: [
          { type: "summary", text: "Healthy account heading into renewal." },
          { type: "questions", items: ["Any renewal blockers?"] },
        ],
      } as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 5,
    };
  },
});

describe("Pre-call brief idempotency and constraints", () => {
  it("two triggers produce one brief per meeting version, with origin=AI and agentRunId set", async () => {
    const { actor: admin } = await createTestAdmin("brief-idempotency");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Brightwell Logistics",
        tier: "HIGH_TOUCH",
      },
    });

    const meeting = await db.meeting.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        title: "Brightwell Executive Catchup",
        startsAt: new Date("2026-11-15T14:00:00Z"),
        endsAt: new Date("2026-11-15T15:00:00Z"),
        status: "SCHEDULED",
      },
    });

    // 1. First trigger
    const brief1 = await prepareBrief(
      admin,
      { meetingId: meeting.id, briefVersion: 1 },
      { provider: makeMockProvider(account.id) },
    );

    expect(brief1.id).toBeDefined();
    expect(brief1.kind).toBe("PRE_CALL_BRIEF");
    expect(brief1.origin).toBe("AI");
    expect(brief1.agentRunId).not.toBeNull();
    expect(brief1.title).toBe("Pre-call Brief: Brightwell Executive Catchup");

    // Verify Meeting links to briefDocumentId
    const updatedMeeting = await db.meeting.findUniqueOrThrow({
      where: { id: meeting.id },
    });
    expect(updatedMeeting.briefDocumentId).toBe(brief1.id);

    // 2. Second trigger with same meeting and version
    const brief2 = await prepareBrief(
      admin,
      { meetingId: meeting.id, briefVersion: 1 },
      { provider: makeMockProvider(account.id) },
    );

    // Assert same document returned
    expect(brief2.id).toBe(brief1.id);

    // Assert exactly 1 Document exists in DB for this account and kind
    const docs = await db.document.findMany({
      where: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        kind: "PRE_CALL_BRIEF",
      },
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(brief1.id);

    // Assert Document check constraint: origin='AI' requires agentRunId
    // If agentRunId is null on AI document, DB rejects
    await expect(
      db.document.create({
        data: {
          workspaceId: admin.workspaceId,
          accountId: account.id,
          kind: "PRE_CALL_BRIEF",
          title: "Illegal AI doc without agent run",
          origin: "AI",
          agentRunId: null,
        },
      }),
    ).rejects.toThrow();
  });
});
