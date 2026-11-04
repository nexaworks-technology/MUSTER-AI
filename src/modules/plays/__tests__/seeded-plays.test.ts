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

  it("12 live plays pass the safety check (M9: Promise Late is live on its detector)", async () => {
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

  it("3 dormant plays fail safety check naming their exact missing detector and home milestone (D9)", async () => {
    const dormantExpectations: Record<string, { detector: string; milestone: string }> = {
      "engagement-loss": {
        detector: "engagement_loss",
        milestone: "M10 (needs meetings)",
      },
      "qbr-due": {
        detector: "qbr.due",
        milestone: "M10",
      },
      "business-review-followup": {
        detector: "business_review.followup",
        milestone: "M10",
      },
    };

    for (const [key, exp] of Object.entries(dormantExpectations)) {
      const play = SEEDED_PLAYS.find((p) => p.key === key);
      expect(play).toBeDefined();
      expect(play!.isDormant).toBe(true);
      expect(play!.homeMilestone).toBe(exp.milestone);

      const res = await validatePlaySafety(play!.definition);
      expect(res.passed).toBe(false);
      expect(
        res.refusals.some(
          (r) => r.includes(exp.detector) && r.includes(exp.milestone),
        ),
      ).toBe(true);
    }
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
