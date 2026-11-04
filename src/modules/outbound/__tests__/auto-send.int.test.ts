import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { enterPlay, publishPlay, type PlayDefinition } from "@/modules/plays/service";
import { CONFIRM_ENABLE_AUTO_SEND, disableAutoSend, enableAutoSend } from "@/modules/settings/service";
import { fixedClock } from "@/lib/dates";

describe("S6: Auto-send guards integration through the play runner (spec §6J4, ARCH §7.4)", () => {
  async function setupAutoSendEnv(opts: {
    contactTimezone?: string | null;
    accountTimezone?: string | null;
    lifecycleStage?: "ONBOARDING" | "ADOPTING" | "MATURE" | "RENEWING" | "LOST";
  } = {}) {
    const { workspace, actor, membership } = await createTestAdmin("AutoSendGuards");
    const db = scopedDb(actor);

    // Enable auto-send via typed confirmation
    await enableAutoSend(actor, { confirmation: CONFIRM_ENABLE_AUTO_SEND });

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Orchard Lane Bakery Supply",
        tier: "LONG_TAIL",
        ownerMembershipId: membership.id,
        timezone: opts.accountTimezone !== undefined ? opts.accountTimezone : "America/New_York",
        lifecycleStage: opts.lifecycleStage ?? "MATURE",
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Harold Baker",
        email: "harold@orchardlane.test",
        timezone: opts.contactTimezone !== undefined ? opts.contactTimezone : "America/New_York",
      },
    });

    const playDef: PlayDefinition = {
      name: "Payment Reminder Play",
      trigger: { type: "signal", ruleKey: "payment_failed" },
      steps: [
        {
          key: "payment-reminder",
          name: "Payment Reminder",
          handler: "send",
          params: {
            mode: "template",
            subject: "Update your payment details for {{account.name}}",
            body: "Hi {{contact.first_name}}, please update your billing method.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: `payment-play-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: playDef.name,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: playDef as unknown as Prisma.InputJsonValue,
      },
    });
    await publishPlay(actor, play.id);

    return { workspace, actor, membership, account, contact, play, db };
  }

  it("1. Guard: unknown customer time zone holds for approval", async () => {
    // Both contact and account have null timezone
    const { actor, account, play, db } = await setupAutoSendEnv({
      contactTimezone: null,
      accountTimezone: null,
    });

    // 14:00 UTC
    const clock = fixedClock("2026-11-04T14:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "tz-unknown-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.status).toBe("HELD");
    expect(msg.heldReason).toContain("time zone is unknown");

    const approval = await db.approval.findUniqueOrThrow({
      where: { id: msg.approvalId! },
    });
    expect(approval.status).toBe("PENDING");
    expect(approval.reason).toContain("time zone is unknown");
  });

  it("2. Guard: quiet hours in contact time zone holds for approval", async () => {
    const { actor, account, play, db } = await setupAutoSendEnv({
      contactTimezone: "America/New_York",
    });

    // In America/New_York (UTC-5 in standard time):
    // 04:00 UTC = 23:00 (11 PM) previous day NY time -> inside quiet hours [19:00, 08:00)
    const clock = fixedClock("2026-11-04T04:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "quiet-hours-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.status).toBe("HELD");
    expect(msg.heldReason).toContain("quiet hours");
  });

  it("3. Guard: open HIGH/URGENT or escalated ticket holds for approval", async () => {
    const { actor, account, play, db } = await setupAutoSendEnv();

    // Create an open urgent ticket on the account
    await db.ticket.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        externalId: "tick-urgent-1",
        subject: "Outage reported",
        status: "OPEN",
        priority: "URGENT",
        openedAt: new Date(),
      },
    });

    // During business hours in NY: 17:00 UTC = 12:00 PM NY
    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "ticket-open-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.status).toBe("HELD");
    expect(msg.heldReason).toContain("ticket(s) are open");
  });

  it("4. Guard: account lifecycle stage LOST never auto-sends", async () => {
    const { actor, account, play } = await setupAutoSendEnv({
      lifecycleStage: "LOST",
    });

    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "lost-ref",
      },
      { executeInline: true, clock },
    );

    // Lost accounts are skipped from play entry
    expect(res.status).toBe("SKIPPED");
    expect(res.reason).toContain("lost");
  });

  it("5. Guard: email suppression list holds for approval", async () => {
    const { actor, account, contact, play, db } = await setupAutoSendEnv();

    await db.emailSuppression.create({
      data: {
        workspaceId: actor.workspaceId,
        email: contact.email!,
        reason: "UNSUBSCRIBED",
      },
    });

    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "suppressed-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.status).toBe("HELD");
    expect(msg.heldReason).toContain("suppression list");
  });

  it("6. Guard: master switch off routes to human approval", async () => {
    const { actor, account, play, db } = await setupAutoSendEnv();

    // Turn auto-send master switch off in settings
    await disableAutoSend(actor);

    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "switch-off-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });
    // With auto-send disabled, step resolves to DRAFT_FOR_APPROVAL
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.sendMode).toBe("APPROVED");
    expect(msg.status).toBe("AWAITING_APPROVAL");
  });

  it("7. Rule 3: Sensitive draft NEVER auto-sends even with auto-send on and all other guards passing", async () => {
    const { actor, account, db } = await setupAutoSendEnv();

    // A play step with sensitive content (cancellation save)
    const sensitivePlayDef: PlayDefinition = {
      name: "Cancellation Save Play",
      trigger: { type: "noteTag", tag: "cancellation-risk" },
      steps: [
        {
          key: "save-offer",
          name: "Save Offer",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Regarding your contract cancellation",
            body: "We received your notice to cancel. We would like to discuss extending your discount.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: true, // Sensitive topic
        },
      ],
    };

    const play = await db.play.create({
      data: {
        workspaceId: actor.workspaceId,
        key: `cancel-play-${Date.now()}`,
        name: sensitivePlayDef.name,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: actor.workspaceId,
        playId: play.id,
        version: 1,
        definition: sensitivePlayDef as unknown as Prisma.InputJsonValue,
      },
    });
    await publishPlay(actor, play.id);

    // Business hours, healthy account, no tickets, no cooldown
    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sensitive-note-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "save-offer" },
    });

    // Sensitive step MUST wait for human approval (Rule 3)
    expect(stepRun.status).toBe("WAITING_APPROVAL");

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.sendMode).toBe("APPROVED");
    expect(msg.status).toBe("AWAITING_APPROVAL");

    const approval = await db.approval.findUniqueOrThrow({
      where: { id: msg.approvalId! },
    });
    expect(approval.isSensitive).toBe(true);
    expect(approval.status).toBe("PENDING");
  });

  it("8. All guards pass: Sundial Fitness auto-sends automatically through dispatch", async () => {
    const { actor, account, play, db } = await setupAutoSendEnv();

    // Noon NY time, healthy, no tickets, no recent sends, not suppressed, auto-send on
    const clock = fixedClock("2026-11-04T17:00:00Z");

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sundial-success-ref",
      },
      { executeInline: true, clock },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "payment-reminder" },
    });

    // When all guards pass and auto-send is enabled for long-tail safe step:
    // The message is dispatched and SENT directly!
    expect(stepRun.status).toBe("DONE");
    expect(stepRun.approvalId).toBeDefined();

    const msg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: stepRun.outboundMessageId! },
    });
    expect(msg.sendMode).toBe("AUTO");
    expect(msg.status).toBe("SENT");
    expect(msg.sentAt).toBeDefined();

    // The approval row was created as AUTO_RECORDED (D7)
    const approval = await db.approval.findUniqueOrThrow({
      where: { id: stepRun.approvalId! },
    });
    expect(approval.status).toBe("AUTO_RECORDED");
    expect(approval.requiredLevel).toBe("SEND_AUTOMATICALLY");
  });
});
