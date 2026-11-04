import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { onboardingManager, renewalManager, runAgent } from "@/modules/agents/service";
import { createTestAdmin } from "@/test/fixtures";
import { completeTask, createTask } from "../service";

let adminA: Actor;
let adminB: Actor;
let accountA: string;
let signalA: string;
let outcomeA: string;

beforeAll(async () => {
  adminA = (await createTestAdmin("TaskSigA")).actor;
  adminB = (await createTestAdmin("TaskSigB")).actor;

  const dbA = scopedDb(adminA);
  const acc = await dbA.account.create({
    data: {
      workspaceId: adminA.workspaceId,
      name: "Acme Corp",
      tier: "MID_TOUCH",
      ownerMembershipId: adminA.membershipId,
    },
  });
  accountA = acc.id;

  const sig = await dbA.signal.create({
    data: {
      workspaceId: adminA.workspaceId,
      accountId: accountA,
      ruleKey: "health_band_drop",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      status: "OPEN",
      title: "Health band dropped",
      explanation: "Test explanation",
      evidence: [{ sourceType: "HealthScoreSnapshot", sourceId: "s1", date: "2026-11-01" }],
      values: {},
      params: {},
      dedupeKey: `health_band_drop:${accountA}`,
      episode: 1,
      firstSeenAt: new Date("2026-11-01T00:00:00Z"),
      lastSeenAt: new Date("2026-11-01T00:00:00Z"),
    },
  });
  signalA = sig.id;

  const out = await dbA.outcomeRecord.create({
    data: {
      workspaceId: adminA.workspaceId,
      accountId: accountA,
      signalId: signalA,
      flagType: "RISK",
      flaggedAt: new Date("2026-11-01T00:00:00Z"),
      actionTaken: "PENDING",
    },
  });
  outcomeA = out.id;
});

describe("Task.signalId and completeTask marks ACTED (Q-48)", () => {
  it("Task can carry signalId and completing it marks the flag's OutcomeRecord ACTED", async () => {
    const task = await createTask(adminA, {
      accountId: accountA,
      signalId: signalA,
      title: "Follow up on risk signal",
      ownerMembershipId: adminA.membershipId,
    });
    expect(task.signalId).toBe(signalA);

    // OutcomeRecord is still PENDING before task completion
    const dbA = scopedDb(adminA);
    const before = await dbA.outcomeRecord.findUniqueOrThrow({ where: { id: outcomeA } });
    expect(before.actionTaken).toBe("PENDING");

    // Complete task
    await completeTask(adminA, task.id);

    // OutcomeRecord is now ACTED with task ref
    const after = await dbA.outcomeRecord.findUniqueOrThrow({ where: { id: outcomeA } });
    expect(after.actionTaken).toBe("ACTED");
    expect(after.firstActionAt).not.toBeNull();
    const refs = after.actionRefs as Array<{ type: string; id: string }>;
    expect(refs).toContainEqual({ type: "Task", id: task.id });
  });

  it("completing a task with no signalId does not modify OutcomeRecord", async () => {
    const task = await createTask(adminA, {
      accountId: accountA,
      title: "Unlinked routine task",
      ownerMembershipId: adminA.membershipId,
    });
    expect(task.signalId).toBeNull();

    await completeTask(adminA, task.id);
    const dbA = scopedDb(adminA);
    const check = await dbA.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(check.status).toBe("DONE");
  });

  it("cross-tenant isolation: Task cannot reference a Signal in another workspace", async () => {
    const dbB = scopedDb(adminB);
    const accB = await dbB.account.create({
      data: {
        workspaceId: adminB.workspaceId,
        name: "Tenant B Account",
        tier: "LONG_TAIL",
        ownerMembershipId: adminB.membershipId,
      },
    });

    // Attempting to create a task in workspace B with signalA (from workspace A) must fail FK constraint
    await expect(
      createTask(adminB, {
        accountId: accB.id,
        signalId: signalA,
        title: "Cross-tenant signal task",
        ownerMembershipId: adminB.membershipId,
      }),
    ).rejects.toThrow();
  });

  it("renewal-manager creates task with signalId and completing it marks ACTED", async () => {
    const dbA = scopedDb(adminA);
    const renewalSig = await dbA.signal.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        ruleKey: "renewal_window_90",
        ruleVersion: 1,
        category: "MONEY",
        severity: "INFO",
        polarity: "RISK",
        status: "OPEN",
        title: "Renews in 90 days",
        explanation: "Test renewal",
        evidence: [{ sourceType: "Renewal", sourceId: "r1", date: "2026-11-01" }],
        values: {},
        params: {},
        dedupeKey: `renewal_window_90:${accountA}:c1:2027-02-01`,
        episode: 1,
        firstSeenAt: new Date("2026-11-01T00:00:00Z"),
        lastSeenAt: new Date("2026-11-01T00:00:00Z"),
      },
    });
    const renewalOutcome = await dbA.outcomeRecord.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        signalId: renewalSig.id,
        flagType: "RISK",
        flaggedAt: new Date("2026-11-01T00:00:00Z"),
        actionTaken: "PENDING",
      },
    });

    const contract = await dbA.contract.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        status: "ACTIVE",
        startDate: new Date("2026-02-01T00:00:00Z"),
        endDate: new Date("2027-02-01T00:00:00Z"),
        valueMinor: 5000000n,
        currency: "USD",
      },
    });

    const renewal = await dbA.renewal.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        contractId: contract.id,
        renewalDate: new Date("2027-02-01T00:00:00Z"),
        confidence: 70,
        confidenceBand: "HIGH",
        confidenceReasons: [],
        confidenceAsOf: new Date("2026-11-01T00:00:00Z"),
      },
    });

    // Run renewal-manager with mock provider
    const provider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Renewal plan prepared for customer",
            confidence: 0.8,
            plan: "Step: Check-in.",
            talkTrack: ["Highlight value delivered."],
            citations: [{ sourceType: "Renewal", sourceId: renewal.id }],
            planSteps: [{ title: "Hold renewal review", detail: "Review account" }],
            outreach: {
              subject: "Planning your renewal",
              body: "Hi team,\n\nYour renewal comes up on {{metric.renewal.date}}.\n\nCSM",
            },
            nextStep: { action: "Schedule renewal review", timing: "within_a_week" as const },
            proposedActions: [],
          } as unknown as T,
          stopReason: "end_turn" as const,
          model: "standard",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      adminA,
      renewalManager,
      { renewalId: renewal.id },
      { type: "signal", id: renewalSig.id },
      { provider },
    );
    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("Expected run outcome");
    expect(out.status).toBe("SUCCEEDED");

    // Check task was created with signalId
    const task = await dbA.task.findFirstOrThrow({
      where: { agentRunId: out.runId },
    });
    expect(task.signalId).toBe(renewalSig.id);

    // Complete task -> marks outcome record ACTED
    await completeTask(adminA, task.id);
    const updated = await dbA.outcomeRecord.findUniqueOrThrow({ where: { id: renewalOutcome.id } });
    expect(updated.actionTaken).toBe("ACTED");
  });

  it("onboarding-manager creates task with signalId and completing it marks ACTED", async () => {
    const dbA = scopedDb(adminA);
    const stallSig = await dbA.signal.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        ruleKey: "onboarding_stall",
        ruleVersion: 1,
        category: "USAGE",
        severity: "WARN",
        polarity: "RISK",
        status: "OPEN",
        title: "Onboarding stalled",
        explanation: "Customer step overdue",
        evidence: [{ sourceType: "OnboardingStep", sourceId: "st1", date: "2026-11-01" }],
        values: {},
        params: {},
        dedupeKey: `onboarding_stall:${accountA}:p1`,
        episode: 1,
        firstSeenAt: new Date("2026-11-01T00:00:00Z"),
        lastSeenAt: new Date("2026-11-01T00:00:00Z"),
      },
    });
    const stallOutcome = await dbA.outcomeRecord.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        signalId: stallSig.id,
        flagType: "RISK",
        flaggedAt: new Date("2026-11-01T00:00:00Z"),
        actionTaken: "PENDING",
      },
    });

    const template = await dbA.onboardingTemplate.create({
      data: {
        workspaceId: adminA.workspaceId,
        name: "Standard Onboarding",
        targetDays: 30,
        steps: [],
        valueDefinition: [],
      },
    });

    const plan = await dbA.onboardingPlan.create({
      data: {
        workspaceId: adminA.workspaceId,
        accountId: accountA,
        templateId: template.id,
        status: "STALLED",
        startDate: new Date("2026-10-01T00:00:00Z"),
        targetValueDate: new Date("2026-11-15T00:00:00Z"),
        stallReason: "Customer step overdue",
        blockers: [{ kind: "step_overdue", days: 5, sources: [] }],
      },
    });

    const provider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Escalating onboarding blocker to CSM",
            confidence: 0.8,
            citations: [{ sourceType: "OnboardingPlan", sourceId: plan.id }],
            subject: null,
            body: null,
            escalation: { needed: true, note: "Please reach out to the customer team." },
            proposedActions: [],
          } as unknown as T,
          stopReason: "end_turn" as const,
          model: "standard",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      adminA,
      onboardingManager,
      { planId: plan.id, reason: "stalled" },
      { type: "signal", id: stallSig.id },
      { provider },
    );
    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("Expected run outcome");
    expect(out.status).toBe("SUCCEEDED");

    const task = await dbA.task.findFirstOrThrow({
      where: { agentRunId: out.runId },
    });
    expect(task.signalId).toBe(stallSig.id);

    await completeTask(adminA, task.id);
    const updated = await dbA.outcomeRecord.findUniqueOrThrow({ where: { id: stallOutcome.id } });
    expect(updated.actionTaken).toBe("ACTED");
  });
});
