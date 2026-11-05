import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { validatePlaySafety } from "../safety";
import { SEEDED_PLAYS } from "../seeded/definitions";
import { seedPlaysForWorkspace } from "../seeded/seed";

describe("S7: The 15 Seeded Plays (spec §5, §6I1, D9)", () => {
  it("all 15 seeded plays exist", () => {
    expect(SEEDED_PLAYS).toHaveLength(15);
    const keys = SEEDED_PLAYS.map((p) => p.key);
    expect(new Set(keys).size).toBe(15);

    const expectedKeys = [
      "health-risk",
      "renewal-risk",
      "renewal-window",
      "onboarding-stall",
      "customer-handoff",
      "champion-loss",
      "adoption-drop",
      "expansion-opportunity",
      "payment-failed",
      "support-escalation",
      "promise-late",
      "qbr-due",
      "engagement-loss",
      "cancellation-save",
      "business-review-followup",
    ];
    for (const key of expectedKeys) {
      expect(keys).toContain(key);
    }
  });

  it("15 live plays pass the safety check (M10: all 15 seeded plays are now live on their detectors)", async () => {
    const liveKeys = [
      "health-risk",
      "renewal-risk",
      "renewal-window",
      "onboarding-stall",
      "customer-handoff",
      "champion-loss",
      "adoption-drop",
      "expansion-opportunity",
      "payment-failed",
      "support-escalation",
      "promise-late",
      "cancellation-save",
      "engagement-loss",
      "qbr-due",
      "business-review-followup",
    ];

    for (const key of liveKeys) {
      const play = SEEDED_PLAYS.find((p) => p.key === key);
      expect(play).toBeDefined();
      const res = await validatePlaySafety(play!.definition);
      expect(
        res.passed,
        `Expected live play "${play!.name}" (${key}) to pass safety check, but failed with: ${res.refusals.join(", ")}`,
      ).toBe(true);
    }
  });

  it("dormant triggers fail safety check naming their missing detector (D9)", async () => {
    const testLocalDormant = {
      name: "Dormant Test Play",
      description: "Test play with dormant trigger",
      category: "general" as const,
      trigger: { type: "event" as const, eventType: "meeting.ended" },
      steps: [
        {
          key: "s1",
          name: "Step 1",
          handler: "task" as const,
          params: { title: "Test", dueDays: 1 },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY" as const,
            MID_TOUCH: "DO_AUTOMATICALLY" as const,
            LONG_TAIL: "DO_AUTOMATICALLY" as const,
          },
          safe: true,
          sensitive: false,
        },
      ],
    };

    const res = await validatePlaySafety(testLocalDormant);
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes("meeting.ended") && r.includes("no detector yet"))).toBe(true);
  });

  it("seedPlaysForWorkspace creates all 15 plays as DRAFT with isSeeded=true (idempotent, create-only)", async () => {
    const { workspace, actor } = await createTestAdmin("SeededPlaysWS");
    const db = scopedDb(actor);

    // Initial seeding
    const seededCount = await seedPlaysForWorkspace(workspace.id);
    expect(seededCount).toBe(15);

    const plays = await db.play.findMany({
      where: { workspaceId: workspace.id },
      include: { versions: true },
    });
    expect(plays).toHaveLength(15);
    expect(plays.every((p) => p.isSeeded)).toBe(true);
    expect(plays.every((p) => p.status === "DRAFT")).toBe(true);
    expect(plays.every((p) => p.versions.length === 1)).toBe(true);

    // Second seeding is create-only: returns 0 and does not duplicate
    const secondCount = await seedPlaysForWorkspace(workspace.id);
    expect(secondCount).toBe(0);

    const afterCount = await db.play.count({ where: { workspaceId: workspace.id } });
    expect(afterCount).toBe(15);
  });
});
