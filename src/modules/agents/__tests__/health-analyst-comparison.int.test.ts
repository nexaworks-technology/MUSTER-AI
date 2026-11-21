import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { healthAnalystContext } from "../definitions/health-analyst";

/**
 * DEMO-WALKTHROUGH (Health Analyst wording): a usage reason compares this week with the account's
 * 90-day normal, but the record gave the model only the week ("period"), and the narrative said the
 * users fell "in one week". The record now says what the value was measured over and what it is
 * compared with, and the prompt says how to word a comparison.
 */
describe("Health Analyst comparison wording", () => {
  it("each reason record names the measured window and what it is compared with", async () => {
    const { actor } = await createTestAdmin("HACompare");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const a = await db.account.create({
      data: { workspaceId: ws, name: "Halv", tier: "HIGH_TOUCH" },
    });
    const model = await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    });
    const snapshotId = randomUUID();
    await db.$tenantTransaction(async (tx) => {
      await tx.healthScoreSnapshot.create({
        data: {
          id: snapshotId,
          workspaceId: ws,
          accountId: a.id,
          healthModelId: model.id,
          asOf: new Date("2026-11-21"),
          overall: 55.7,
          riskLevel: "WATCH",
          riskLevelExcludingPulse: "WATCH",
          effectiveWeights: {},
          inputsHash: snapshotId,
        },
      });
      await tx.healthReason.create({
        data: {
          workspaceId: ws,
          snapshotId,
          pillar: "ADOPTION",
          component: "active_vs_own",
          kind: "EVIDENCE",
          direction: "DOWN",
          impact: -9,
          input: "active_users_typical_weekday",
          message:
            "Typical weekday active users fell from 61.4 to 13 (−79%) against this account's normal (Aug 14 – Nov 13, 2026).",
          value: 13,
          baseline: 61.4,
          periodStart: new Date("2026-11-14"),
          periodEnd: new Date("2026-11-21"),
          sources: [{ sourceType: "Account", sourceId: a.id }],
        },
      });
    });
    const { bundle } = await healthAnalystContext(actor, { accountId: a.id, snapshotId });
    const r = bundle.find((x) => x.sourceType === "HealthReason")!;
    expect(r.fields).toMatchObject({
      value: 13,
      baseline: 61.4,
      valueMeasuredOver: "Nov 14, 2026 – Nov 21, 2026",
      baselineIs:
        "what the message compares the value with (for usage, this account's own normal period named in the message), not the start of the measured window",
    });
    expect(r.fields).not.toHaveProperty("period");
  });

  it("the prompt says a comparison is not a change over the measured window", () => {
    const prompt = readFileSync("prompts/health-analyst.md", "utf8");
    expect(prompt).toMatch(/^version: 1\.1\.0$/m);
    expect(prompt).toMatch(/never say a value (fell|changed) "in" or "over" the measured window/i);
  });
});
