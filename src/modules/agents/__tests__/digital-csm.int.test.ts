import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { digitalCsm } from "../definitions/digital-csm";
import { runAgent } from "../executor";

describe("S9: Digital CSM Agent & Hand-off Rules (spec §8, M8.md)", () => {
  it("normal long-tail check-in creates Approval at DRAFT_FOR_APPROVAL", async () => {
    const { workspace, actor: admin } = await createTestAdmin("DigitalCsmNormalWS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Small Business Inc",
        tier: "LONG_TAIL",
        ownerMembershipId: admin.membershipId,
      },
    });
    const contact = await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Alice Smith",
        email: "alice@smallbiz.test",
      },
    });

    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Routine safe check-in for long-tail account.",
            confidence: 0.9,
            citations: [{ sourceType: "Account", sourceId: account.id }],
            proposedActions: [],
            subject: "How is everything going with your account?",
            body: "Hi Alice,\n\nJust checking in to see if you need any help with your setup.\n\nBest,\nDigital CSM",
            handedOff: false,
            handoffReason: null,
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      admin,
      digitalCsm,
      {
        accountId: account.id,
        contactId: contact.id,
        stepKey: "step-1",
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    expect(out.status).toBe("SUCCEEDED");
    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
    expect(run.actionTaken).toBe("APPROVAL_REQUESTED");
    const effects = run.effects as Array<{ type: string; id: string }>;
    expect(effects.some((e) => e.type === "Approval")).toBe(true);

    // Verify Approval was created
    const approvalId = effects.find((e) => e.type === "Approval")?.id;
    const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.requiredLevel).toBe("DRAFT_FOR_APPROVAL");
    expect(approval.isSensitive).toBe(false);
  });

  it("angry/pricing/legal content or risk signal triggers human hand-off (Task + Approval, no direct send)", async () => {
    const { workspace, actor: admin } = await createTestAdmin("DigitalCsmHandOffWS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Frustrated Client LLC",
        tier: "LONG_TAIL",
        ownerMembershipId: admin.membershipId,
      },
    });
    const contact = await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Bob Angry",
        email: "bob@angryclient.test",
      },
    });

    // Inbound message containing anger and cancellation threat
    const conv = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        channel: "EMAIL",
        startedAt: new Date(),
        lastMessageAt: new Date(),
      },
    });
    await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: conv.id,
        accountId: account.id,
        direction: "INBOUND",
        subject: "Terrible service",
        bodyText: "I am furious with this bug and want to cancel our subscription and speak with your legal team.",
        sentAt: new Date(),
      },
    });

    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Customer threatens cancellation and mentions legal team; handing off to human.",
            confidence: 0.95,
            citations: [{ sourceType: "Account", sourceId: account.id }],
            proposedActions: [],
            subject: "Regarding your recent note",
            body: "Hi Bob,\n\nI hear your frustration. I am handing this off to our management team right away.\n\nBest,\nDigital CSM",
            handedOff: true,
            handoffReason: "Customer expressed anger, cancellation threat, and legal concerns.",
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      admin,
      digitalCsm,
      {
        accountId: account.id,
        contactId: contact.id,
        stepKey: "step-handoff",
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    expect(out.status).toBe("SUCCEEDED");
    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
    expect(run.actionTaken).toBe("TASK_CREATED");
    const effects = run.effects as Array<{ type: string; id: string }>;

    // Effects must include a Task for human hand-off and an Approval marked sensitive
    const taskEffect = effects.find((e) => e.type === "Task");
    const approvalEffect = effects.find((e) => e.type === "Approval");
    expect(taskEffect).toBeDefined();
    expect(approvalEffect).toBeDefined();

    // Verify task
    const task = await db.task.findUniqueOrThrow({ where: { id: taskEffect!.id } });
    expect(task.priority).toBe("HIGH");
    expect(task.title).toContain("Hand-off");
    expect(task.ownerMembershipId).toBe(admin.membershipId);

    // Verify approval is marked sensitive
    const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalEffect!.id } });
    expect(approval.isSensitive).toBe(true);
    expect(approval.requiredLevel).toBe("DRAFT_FOR_APPROVAL");
  });

  it("Rule 5 compliance: AgentRun fully records prompt version, model, inputs, reasoning, confidence, effects", async () => {
    const { workspace, actor: admin } = await createTestAdmin("DigitalCsmRule5WS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: { workspaceId: workspace.id, name: "Rule 5 Corp", tier: "LONG_TAIL", ownerMembershipId: admin.membershipId },
    });
    const contact = await db.contact.create({
      data: { workspaceId: workspace.id, accountId: account.id, name: "Charlie", email: "charlie@rule5.test" },
    });

    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Safe touchpoint for long-tail account.",
            confidence: 0.88,
            citations: [{ sourceType: "Account", sourceId: account.id }],
            proposedActions: [],
            subject: "Checking in on your progress",
            body: "Hi Charlie,\n\nHow are things progressing?\n\nBest,\nDigital CSM",
            handedOff: false,
            handoffReason: null,
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      admin,
      digitalCsm,
      {
        accountId: account.id,
        contactId: contact.id,
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
    expect(run.agentKey).toBe("digital-csm");
    expect(run.agentVersion).toBe("1.0.0");
    expect(run.promptName).toBe("digital-csm");
    expect(run.promptVersion).toBe("1.0.0");
    expect(run.confidence).toBe(0.88);
    expect(run.reasoningSummary).toBe("Safe touchpoint for long-tail account.");
    expect(run.effects).toBeTruthy();
  });
});
