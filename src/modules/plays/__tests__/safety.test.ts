import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { PlayDefinition } from "../definition";
import { validatePlaySafety } from "../safety";
import { publishPlay } from "../service";

const validBasePlay: PlayDefinition = {
  name: "Health Drop Alert",
  description: "Alerts CSM when health score drops",
  category: "risk",
  trigger: { type: "signal", ruleKey: "health_band_drop" },
  conditions: [],
  branches: [],
  steps: [
    {
      key: "notify-csm",
      name: "Notify CSM",
      handler: "notify",
      params: { message: "Health score dropped for {{account.name}}" },
      approvalLevelByTier: {
        HIGH_TOUCH: "NOTIFY_ONLY",
        MID_TOUCH: "NOTIFY_ONLY",
        LONG_TAIL: "NOTIFY_ONLY",
      },
      safe: true,
      sensitive: false,
    },
  ],
};

describe("Play safety gate (pre-publish hard gate, safety.ts)", () => {
  it("passes a valid play definition", async () => {
    const res = await validatePlaySafety(validBasePlay);
    expect(res.passed).toBe(true);
    expect(res.refusals).toEqual([]);
  });

  it("refusal: the play does nothing (no steps and no branch steps)", async () => {
    const emptyPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [],
      branches: [],
    };
    const res = await validatePlaySafety(emptyPlay);
    expect(res.passed).toBe(false);
    expect(res.refusals).toContain("This play does nothing: it has no steps with any effect.");
  });

  it("refusal: missing required setting (params incomplete)", async () => {
    const missingSettingsPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "task-1",
          name: "Follow up task",
          handler: "task",
          params: {}, // missing title and ownerRole
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(missingSettingsPlay);
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes("missing required setting") || r.includes("Task title"))).toBe(true);
    expect(res.stepRefusals?.["task-1"]).toBeDefined();
  });

  it("refusal: step handler is not registered", async () => {
    const unregisteredHandlerPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "sms-1",
          name: "Send SMS",
          handler: "send_sms" as any,
          params: { to: "+123456789" },
          approvalLevelByTier: {
            HIGH_TOUCH: "SEND_AUTOMATICALLY",
            MID_TOUCH: "SEND_AUTOMATICALLY",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(unregisteredHandlerPlay);
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes('handler "send_sms" is not registered'))).toBe(true);
  });

  it("refusal: missing approval level for a tier", async () => {
    const missingApprovalLevelPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "draft-1",
          name: "Draft email",
          handler: "draft",
          params: {
            mode: "agent",
            prompt: "Check in with the customer",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            // LONG_TAIL is missing
          } as any,
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(missingApprovalLevelPlay);
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes("missing approval level") && r.includes("LONG_TAIL"))).toBe(true);
  });

  it("refusal: auto-send on a sensitive topic (sensitive: true, unsafe step, or sensitive text)", async () => {
    const sensitiveAutoSendPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "cancel-draft",
          name: "Cancellation save offer",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Your cancellation request",
            body: "We received your request to cancel the contract. Let us offer a discount.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "SEND_AUTOMATICALLY", // Invalid: sensitive topic
          },
          safe: true,
          sensitive: true,
        },
      ],
    };
    const res = await validatePlaySafety(sensitiveAutoSendPlay);
    expect(res.passed).toBe(false);
    expect(
      res.refusals.some(
        (r) => r.includes("cannot send automatically on a sensitive topic") || r.includes("SEND_AUTOMATICALLY on a sensitive step"),
      ),
    ).toBe(true);
  });

  it("refusal: design-time cap breach (multiple customer sends without wait >= 48h)", async () => {
    const capBreachPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "send-1",
          name: "First send",
          handler: "send",
          params: {
            template: "Hello {{contact.name}}",
            subject: "First notice",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "send-2",
          name: "Second send",
          handler: "send",
          params: {
            template: "Hello again {{contact.name}}",
            subject: "Followup notice",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(capBreachPlay);
    expect(res.passed).toBe(false);
    expect(
      res.refusals.some((r) => r.includes("frequency cap") || r.includes("without at least 48 hours")),
    ).toBe(true);
  });

  it("refusal: template / metric violations (D5: raw number in text, unknown metric, malformed)", async () => {
    const templateViolationPlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "template-draft",
          name: "Template check-in",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Check in on your {{metric.unknown_metric}}", // unknown metric
            body: "You currently have 5 inactive seats outside {{metric.renewal.date}}", // raw number "5"
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(templateViolationPlay);
    expect(res.passed).toBe(false);
    expect(
      res.refusals.some(
        (r) =>
          r.includes("number") ||
          r.includes("unknown_metric") ||
          r.includes("placeholder"),
      ),
    ).toBe(true);
  });

  it("refusal: segment violations (D6: deleted segment or tier exclusion)", async () => {
    const segmentMissingPlay: PlayDefinition = {
      ...validBasePlay,
      segmentId: "nonexistent-segment-id",
    };
    const res = await validatePlaySafety(segmentMissingPlay, {
      resolveSegment: async (_id) => null,
    });
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes('Segment "nonexistent-segment-id" not found'))).toBe(true);

    // Segment that excludes play tier
    const segmentExcludingTierPlay: PlayDefinition = {
      ...validBasePlay,
      segmentId: "segment-long-tail-only",
      branches: [
        {
          tier: "HIGH_TOUCH",
          steps: [
            {
              key: "notify-high",
              name: "High touch step",
              handler: "notify",
              params: { message: "High touch" },
              approvalLevelByTier: {
                HIGH_TOUCH: "NOTIFY_ONLY",
                MID_TOUCH: "NOTIFY_ONLY",
                LONG_TAIL: "NOTIFY_ONLY",
              },
              safe: true,
              sensitive: false,
            },
          ],
        },
      ],
    };
    const res2 = await validatePlaySafety(segmentExcludingTierPlay, {
      resolveSegment: async (id) => ({
        id,
        filter: { tier: { op: "eq", value: "LONG_TAIL" } },
      }),
    });
    expect(res2.passed).toBe(false);
    expect(
      res2.refusals.some((r) => r.includes("excludes tier") || r.includes("incompatible")),
    ).toBe(true);
  });

  it("refusal: dormant-trigger play cannot activate (D9)", async () => {
    // 1. Promise Late (M9)
    const promiseLatePlay: PlayDefinition = {
      ...validBasePlay,
      trigger: { type: "signal", ruleKey: "promise_late" },
    };
    const res1 = await validatePlaySafety(promiseLatePlay);
    expect(res1.passed).toBe(false);
    expect(res1.refusals.some((r) => r.includes("promise_late") && r.includes("M9"))).toBe(true);

    // 2. Engagement Loss (M9/M10)
    const engagementLossPlay: PlayDefinition = {
      ...validBasePlay,
      trigger: { type: "signal", ruleKey: "engagement_loss" },
    };
    const res2 = await validatePlaySafety(engagementLossPlay);
    expect(res2.passed).toBe(false);
    expect(res2.refusals.some((r) => r.includes("engagement_loss") && (r.includes("M9") || r.includes("M10")))).toBe(true);

    // 3. QBR Due (M10)
    const qbrDuePlay: PlayDefinition = {
      ...validBasePlay,
      trigger: { type: "event", eventType: "meeting.qbr_due" },
    };
    const res3 = await validatePlaySafety(qbrDuePlay);
    expect(res3.passed).toBe(false);
    expect(res3.refusals.some((r) => r.includes("qbr") && r.includes("M10"))).toBe(true);

    // 4. Business Review Follow-up (M10)
    const brFollowupPlay: PlayDefinition = {
      ...validBasePlay,
      trigger: { type: "event", eventType: "meeting.ended" },
    };
    const res4 = await validatePlaySafety(brFollowupPlay);
    expect(res4.passed).toBe(false);
    expect(res4.refusals.some((r) => r.includes("meeting.ended") && r.includes("M10"))).toBe(true);
  });

  it("refusal: unreachable step or impossible branch condition", async () => {
    const unreachablePlay: PlayDefinition = {
      ...validBasePlay,
      steps: [
        {
          key: "exit-step",
          name: "Exit step",
          handler: "exit",
          params: { reason: "Customer replied" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "after-exit",
          name: "Unreachable notify",
          handler: "notify",
          params: { message: "This cannot run" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };
    const res = await validatePlaySafety(unreachablePlay);
    expect(res.passed).toBe(false);
    expect(res.refusals.some((r) => r.includes('Step "after-exit" is unreachable'))).toBe(true);
  });

  it("failing play stays DRAFT; successful activation is audited", async () => {
    const { actor } = await createTestAdmin("PlaySafetyPub");
    const db = scopedDb(actor);

    // 1. Create a play with an invalid definition (does nothing)
    const playBad = await db.play.create({
      data: {
        workspaceId: actor.workspaceId,
        key: "bad-play",
        name: "Bad Play",
        status: "DRAFT",
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: actor.workspaceId,
        playId: playBad.id,
        version: 1,
        definition: {
          name: "Bad Play",
          trigger: { type: "signal", ruleKey: "health_band_drop" },
          steps: [],
          branches: [],
        },
      },
    });

    const badResult = await publishPlay(actor, playBad.id);
    expect(badResult.status).toBe("REFUSED");

    // Play remains DRAFT
    const playBadAfter = await db.play.findUniqueOrThrow({ where: { id: playBad.id } });
    expect(playBadAfter.status).toBe("DRAFT");
    expect(playBadAfter.currentVersionId).toBeNull();

    // 2. Create a play with a valid definition
    const playGood = await db.play.create({
      data: {
        workspaceId: actor.workspaceId,
        key: "good-play",
        name: "Good Play",
        status: "DRAFT",
      },
    });
    const goodVersion = await db.playVersion.create({
      data: {
        workspaceId: actor.workspaceId,
        playId: playGood.id,
        version: 1,
        definition: validBasePlay,
      },
    });

    const goodResult = await publishPlay(actor, playGood.id);
    expect(goodResult.status).toBe("PUBLISHED");

    // Play is now PUBLISHED and currentVersionId is set
    const playGoodAfter = await db.play.findUniqueOrThrow({ where: { id: playGood.id } });
    expect(playGoodAfter.status).toBe("PUBLISHED");
    expect(playGoodAfter.currentVersionId).toBe(goodVersion.id);

    // Activation is audited
    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        workspaceId: actor.workspaceId,
        action: "play.published",
        targetId: playGood.id,
      },
    });
    expect(audit.summary).toContain('Published play "Good Play" v1');
  });
});
