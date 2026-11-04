import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { renewalManager, runAgent } from "@/modules/agents/service";
import {
  adoptRenewalPlan,
  PlanAdoptionValidationError,
} from "@/modules/renewals/service";
import { createTestAdmin } from "@/test/fixtures";

describe("S12: Renewal Plan Adoption (D-139, spec §6H2)", () => {
  it("adopts plan steps into Renewal.planSteps and audits renewal.plan_adopted", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlanAdoptionWS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Adoption Test Corp",
        tier: "MID_TOUCH",
      },
    });

    const contract = await db.contract.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2027-01-01"),
        valueMinor: 5000000n,
      },
    });

    const renewal = await db.renewal.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        contractId: contract.id,
        renewalDate: new Date("2027-01-01"),
        confidence: 75,
        confidenceBand: "HIGH",
        confidenceAsOf: new Date("2026-11-01"),
        planSteps: [],
      },
    });

    // Human adopts editable steps
    const result = await adoptRenewalPlan(admin, {
      renewalId: renewal.id,
      steps: [
        {
          title: "Schedule Q4 renewal alignment",
          detail: "Meet with decision maker regarding {{metric.renewal.arr}} continuation.",
        },
        {
          title: "Present ROI summary and product usage milestones",
          detail: null,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.steps.length).toBe(2);

    // Verify Renewal.planSteps is populated
    const updated = await db.renewal.findUniqueOrThrow({ where: { id: renewal.id } });
    const steps = updated.planSteps as Array<{ title: string; detail: string | null }>;
    expect(steps.length).toBe(2);
    expect(steps[0]?.title).toBe("Schedule Q4 renewal alignment");
    expect(steps[0]?.detail).toContain("{{metric.renewal.arr}}");
    expect(steps[1]?.title).toBe("Present ROI summary and product usage milestones");

    // Verify audit log
    const audits = await db.auditLog.findMany({
      where: {
        workspaceId: workspace.id,
        targetId: renewal.id,
        action: "renewal.plan_adopted",
      },
    });
    expect(audits.length).toBe(1);
    expect(audits[0]?.actorId).toBe(admin.userId);
    expect(audits[0]?.summary).toContain("Adopted 2 renewal plan step(s)");
  });

  it("enforces M7 placeholder validation rule on adopted steps", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlanPlaceholdersWS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Placeholder Test Corp",
        tier: "MID_TOUCH",
      },
    });

    const contract = await db.contract.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2027-01-01"),
      },
    });

    const renewal = await db.renewal.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        contractId: contract.id,
        renewalDate: new Date("2027-01-01"),
        confidence: 60,
        confidenceBand: "MEDIUM",
        confidenceAsOf: new Date("2026-11-01"),
        planSteps: [],
      },
    });

    // Unknown metric placeholder fails M7 validation rule
    await expect(
      adoptRenewalPlan(admin, {
        renewalId: renewal.id,
        steps: [
          {
            title: "Review unknown {{metric.unknown_fake_metric}} data",
            detail: "Should fail validation",
          },
        ],
      }),
    ).rejects.toThrow(PlanAdoptionValidationError);

    // Empty step title fails
    await expect(
      adoptRenewalPlan(admin, {
        renewalId: renewal.id,
        steps: [{ title: "", detail: "No title" }],
      }),
    ).rejects.toThrow(PlanAdoptionValidationError);
  });

  it("invariant: Renewal Manager agent does NOT silently adopt plan into Renewal.planSteps", async () => {
    const { workspace, actor: admin } = await createTestAdmin("NoSilentAdoptionWS");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Silent Adoption Guard Corp",
        tier: "HIGH_TOUCH",
      },
    });

    await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Jane Doe",
        email: "jane@guard.test",
        status: "ACTIVE",
      },
    });

    const contract = await db.contract.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2027-01-01"),
        valueMinor: 10000000n,
      },
    });

    const renewal = await db.renewal.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        contractId: contract.id,
        renewalDate: new Date("2027-01-01"),
        confidence: 80,
        confidenceBand: "HIGH",
        confidenceAsOf: new Date("2026-11-01"),
        planSteps: [],
      },
    });

    // Run Renewal Manager
    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Standard high confidence renewal plan.",
            confidence: 0.9,
            citations: [{ sourceType: "Renewal", sourceId: renewal.id }],
            proposedActions: [],
            planSteps: [
              {
                title: "Confirm executive business review date",
                detail: "Discuss upcoming expansion.",
              },
            ],
            talkTrack: ["Emphasize usage growth."],
            outreach: {
              subject: "Upcoming renewal alignment",
              body: "Looking forward to your renewal on {{metric.renewal.date}}.",
            },
            nextStep: {
              action: "Schedule EBR",
              timing: "within_a_week",
            },
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 20,
          outputTokens: 40,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      admin,
      renewalManager,
      { renewalId: renewal.id },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("Expected run outcome");
    expect(out.status).toBe("SUCCEEDED");

    // Invariant: Renewal.planSteps MUST REMAIN EMPTY until human adopts!
    const renewalAfterAgent = await db.renewal.findUniqueOrThrow({ where: { id: renewal.id } });
    expect(Array.isArray(renewalAfterAgent.planSteps)).toBe(true);
    expect((renewalAfterAgent.planSteps as unknown[]).length).toBe(0);

    // Now human adopts the proposed steps:
    await adoptRenewalPlan(admin, {
      renewalId: renewal.id,
      steps: [
        {
          title: "Confirm executive business review date",
          detail: "Discuss upcoming expansion.",
        },
      ],
    });

    const renewalAfterAdoption = await db.renewal.findUniqueOrThrow({ where: { id: renewal.id } });
    expect((renewalAfterAdoption.planSteps as unknown[]).length).toBe(1);
  });
});
