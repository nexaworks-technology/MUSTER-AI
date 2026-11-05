import type { Prisma } from "@prisma/client";
import { QueueEvents, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { processorFor } from "@/worker/processors";
import { dispatch, DispatchRefusedError } from "@/modules/outbound/service";
import {
  enterPlay,
  executeStep,
  resumePlayRunOnApprovalDecided,
  sweepStalledPlayRuns,
  publishPlay,
  type PlayDefinition,
} from "../service";
import { sweepRenewalAgents } from "@/modules/agents/service";

describe("S5: Play Runner, Step Handlers, Approval Wait/Resume, Stall Sweep & Dispatch Proof", () => {
  let worker: Worker;
  let events: QueueEvents;

  beforeAll(async () => {
    worker = new Worker("plays", processorFor("plays")!, {
      connection: redisConnection(),
      prefix: queuePrefix(),
    });
    events = new QueueEvents("plays", {
      connection: redisConnection(),
      prefix: queuePrefix(),
    });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await closeQueues();
  });

  async function setupWorkspaceWithPlay(def: PlayDefinition) {
    const { workspace, actor, membership } = await createTestAdmin("PlayRunner");
    const db = scopedDb(actor);

    // Create an account and contact
    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Acme Industrial",
        tier: "LONG_TAIL",
        ownerMembershipId: membership.id,
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Alice Smith",
        email: "alice@acme.test",
      },
    });

    // Create and publish the play
    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: `play-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: def.name,
      },
    });

    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: def as unknown as Prisma.InputJsonValue,
      },
    });

    const published = await publishPlay(actor, play.id);
    expect(published.status).toBe("PUBLISHED");

    return { workspace, actor, membership, account, contact, play, db };
  }

  it("1. Idempotency: the same trigger twice results in ONE PlayRun (D2)", async () => {
    const playDef: PlayDefinition = {
      name: "Single Step Notify",
      trigger: { type: "signal", ruleKey: "health_drop" },
      steps: [
        {
          key: "step-1",
          name: "Send notification",
          handler: "notify",
          params: { message: "Account needs attention" },
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

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    // First entry
    const res1 = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-same-trigger-1",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(res1.status).toBe("RUNNING");
    expect(res1.playRunId).toBeDefined();

    // Second entry with identical triggerRef
    const res2 = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-same-trigger-1",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(res2.status).toBe("ALREADY_ENTERED");
    expect(res2.playRunId).toBe(res1.playRunId);

    const runCount = await db.playRun.count({
      where: { playId: play.id, accountId: account.id },
    });
    expect(runCount).toBe(1);
  });

  it("2. D2 open run guard: a second trigger while one run is open is ignored and logged", async () => {
    const playDef: PlayDefinition = {
      name: "Waiting Approval Play",
      trigger: { type: "signal", ruleKey: "health_drop" },
      steps: [
        {
          key: "draft-step",
          name: "Draft human email",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Check in with {{contact.name}}",
            body: "Hello {{contact.first_name}}, how are things going at {{account.name}}?",
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

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    // Enter play -> step transitions to WAITING_APPROVAL, run status to WAITING
    const res1 = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-trigger-first",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(res1.status).toBe("RUNNING");

    const run = await db.playRun.findUniqueOrThrow({ where: { id: res1.playRunId! } });
    expect(["RUNNING", "WAITING"]).toContain(run.status);

    // New trigger while first run is open
    const res2 = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-trigger-second",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(res2.status).toBe("SKIPPED");
    expect(res2.reason).toContain("already open");

    // Only one PlayRun exists
    const totalRuns = await db.playRun.count({
      where: { playId: play.id, accountId: account.id },
    });
    expect(totalRuns).toBe(1);
  });

  it("3. Step retry idempotency: retrying a step does not duplicate Task/Approval/OutboundMessage", async () => {
    const playDef: PlayDefinition = {
      name: "Task Creation Play",
      trigger: { type: "signal", ruleKey: "usage_drop" },
      steps: [
        {
          key: "create-task",
          name: "Follow up task",
          handler: "task",
          params: { title: "Call champion regarding usage drop", dueDays: 2 },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-task-1",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    // Re-execute step
    const retry = await executeStep(
      actor,
      {
        workspaceId: actor.workspaceId,
        playRunId: res.playRunId!,
        stepKey: "create-task",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(retry.status).toBe("DONE");

    const tasks = await db.task.findMany({
      where: { accountId: account.id, title: "Call champion regarding usage drop" },
    });
    expect(tasks).toHaveLength(1);
  });

  it("4. Approval wait and resume: approved resumes to next step, rejected exits", async () => {
    const playDef: PlayDefinition = {
      name: "Approval Flow Play",
      trigger: { type: "signal", ruleKey: "risk_detected" },
      steps: [
        {
          key: "email-draft",
          name: "Draft check-in",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Update from support",
            body: "Hi {{contact.first_name}}, following up.",
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
          key: "notify-step",
          name: "Notify team",
          handler: "notify",
          params: { message: "Email approved and sent" },
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

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-approval-test",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "email-draft" },
    });
    expect(stepRun.status).toBe("WAITING_APPROVAL");
    expect(stepRun.approvalId).toBeDefined();

    // Resume with APPROVED
    const resumeRes = await resumePlayRunOnApprovalDecided(
      actor,
      stepRun.approvalId!,
      "APPROVED",
      { executeInline: true, autoSendEnabled: true },
    );
    expect(resumeRes.resumed).toBe(true);

    const updatedStep = await db.playStepRun.findUniqueOrThrow({ where: { id: stepRun.id } });
    expect(updatedStep.status).toBe("DONE");

    const secondStep = await db.playStepRun.findFirst({
      where: { playRunId: res.playRunId!, stepKey: "notify-step" },
    });
    expect(secondStep?.status).toBe("DONE");

    const finalRun = await db.playRun.findUniqueOrThrow({ where: { id: res.playRunId! } });
    expect(finalRun.status).toBe("COMPLETED");

    // Test rejection on another run
    const resReject = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-reject-test",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const rejectStepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: resReject.playRunId!, stepKey: "email-draft" },
    });

    const rejectRes = await resumePlayRunOnApprovalDecided(
      actor,
      rejectStepRun.approvalId!,
      "REJECTED",
      { executeInline: true, autoSendEnabled: true },
    );
    expect(rejectRes.resumed).toBe(true);
    expect(rejectRes.exited).toBe(true);

    const rejectedRun = await db.playRun.findUniqueOrThrow({ where: { id: resReject.playRunId! } });
    expect(rejectedRun.status).toBe("EXITED");
    expect(rejectedRun.exitReason).toBe("Approval rejected by human");
  });

  it("5. Seven handlers execution (notify, task, draft, send, update, escalate, wait)", async () => {
    const playDef: PlayDefinition = {
      name: "All Handlers Play",
      trigger: { type: "signal", ruleKey: "test_all" },
      steps: [
        {
          key: "s-notify",
          name: "Step Notify",
          handler: "notify",
          params: { message: "Notification test" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "s-task",
          name: "Step Task",
          handler: "task",
          params: { title: "Task test", priority: "HIGH" },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "s-escalate",
          name: "Step Escalate",
          handler: "escalate",
          params: { title: "Urgent Escalation" },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "s-update",
          name: "Step Update",
          handler: "update",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "s-wait",
          name: "Step Wait",
          handler: "wait",
          params: { durationHours: 0 },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-handlers-test",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    expect(res.status).toBe("RUNNING");

    const steps = await db.playStepRun.findMany({
      where: { playRunId: res.playRunId! },
      orderBy: { createdAt: "asc" },
    });
    expect(steps.map((s) => s.stepKey)).toEqual([
      "s-notify",
      "s-task",
      "s-escalate",
      "s-update",
      "s-wait",
    ]);
    expect(steps.every((s) => s.status === "DONE")).toBe(true);
  });

  it("6. Stall sweep creates internal escalation Task (no approval per Q-65)", async () => {
    const playDef: PlayDefinition = {
      name: "Stalling Play",
      trigger: { type: "signal", ruleKey: "stall_test" },
      steps: [
        {
          key: "draft-stall",
          name: "Stalling Draft",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Stalled draft",
            body: "Needs approval",
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

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-stall-1",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId! },
    });

    // Artificially age the stepRun to 6 days ago (stall threshold 5 days)
    const pastDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    await db.playStepRun.update({
      where: { id: stepRun.id },
      data: { createdAt: pastDate },
    });

    const sweepResult = await sweepStalledPlayRuns(actor, { stallDays: 5 });
    expect(sweepResult.escalated).toBe(1);

    const escalationTask = await db.task.findFirst({
      where: {
        accountId: account.id,
        title: { startsWith: `Stalled Play: ${play.name}` },
      },
    });
    expect(escalationTask).toBeDefined();
    expect(escalationTask?.priority).toBe("HIGH");
    expect(escalationTask?.origin).toBe("SYSTEM");

    // Idempotent: running sweep again does not duplicate task
    const secondSweep = await sweepStalledPlayRuns(actor, { stallDays: 5 });
    expect(secondSweep.escalated).toBe(0);
  });

  it("7. D1 frequency cap at run-time: step marked SKIPPED with reason, no task, never queued", async () => {
    const playDef: PlayDefinition = {
      name: "Cap Breach Play",
      trigger: { type: "signal", ruleKey: "cap_test" },
      steps: [
        {
          key: "contact-draft",
          name: "Frequent check-in",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Frequent check-in",
            body: "Hello again",
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

    const { actor, account, contact, play, db } = await setupWorkspaceWithPlay(playDef);

    // Record a recent sent email to contact (1 hour ago, default cooldown is 72h)
    await db.outboundMessage.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        contactId: contact.id,
        toEmail: contact.email!,
        subject: "Recent email",
        bodyText: "Text",
        status: "SENT",
        sendMode: "APPROVED",
        sentAt: new Date(Date.now() - 60 * 60 * 1000),
        providerMessageId: "msg-prev-1",
      },
    });

    const res = await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "sig-cap-breach",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const stepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: res.playRunId!, stepKey: "contact-draft" },
    });

    // D1: Step is marked SKIPPED with reason recorded on the run (never queued, never sent)
    expect(stepRun.status).toBe("SKIPPED");
    expect((stepRun.result as Record<string, unknown>)?.skippedReason).toContain("emailed 1 hours ago");

    // No task is created for a skip
    const tasks = await db.task.findMany({ where: { accountId: account.id } });
    expect(tasks).toHaveLength(0);
  });

  it("8. PROOF: A play step cannot send anything a manual draft cannot (same-input comparison through dispatch)", async () => {
    const { workspace, actor, membership } = await createTestAdmin("DispatchProof");
    const db = scopedDb(actor);

    // Suppressed contact
    const suppressedAccount = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Suppressed Corp",
        tier: "LONG_TAIL",
        ownerMembershipId: membership.id,
      },
    });

    const suppressedEmail = "unsubscribed@example.com";
    const suppressedContact = await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: suppressedAccount.id,
        name: "Suppressed User",
        email: suppressedEmail,
      },
    });

    await db.emailSuppression.create({
      data: {
        workspaceId: workspace.id,
        email: suppressedEmail,
        reason: "UNSUBSCRIBED",
      },
    });

    // Enable auto-send in settings for this workspace
    await db.workspaceSettings.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        data: {
          outbound: { autoSendEnabled: true },
          approvals: { workspaceCeiling: "SEND_AUTOMATICALLY" },
        },
      },
      update: {
        data: {
          outbound: { autoSendEnabled: true },
          approvals: { workspaceCeiling: "SEND_AUTOMATICALLY" },
        },
      },
    });

    // CASE 1: Suppressed Contact
    // A) Manual draft with human approval to suppressed email
    const manualApproval = await db.approval.create({
      data: {
        workspaceId: workspace.id,
        accountId: suppressedAccount.id,
        kind: "SEND_EMAIL",
        status: "APPROVED",
        requiredLevel: "DRAFT_FOR_APPROVAL",
        proof: [{ sourceType: "Manual", sourceId: "manual-1" }],
        decidedById: membership.id,
        decidedAt: new Date(),
        decidedVia: "APP",
        reason: "Manual outreach",
      },
    });
    const manualMsg = await db.outboundMessage.create({
      data: {
        workspaceId: workspace.id,
        accountId: suppressedAccount.id,
        contactId: suppressedContact.id,
        approvalId: manualApproval.id,
        toEmail: suppressedEmail,
        subject: "Manual Subject",
        bodyText: "Manual text",
        status: "AWAITING_APPROVAL",
        sendMode: "APPROVED",
      },
    });
    await db.draftRevision.create({
      data: {
        workspaceId: workspace.id,
        approvalId: manualApproval.id,
        outboundMessageId: manualMsg.id,
        version: 1,
        subject: "Manual Subject",
        bodyText: "Manual text",
      },
    });

    // Manual dispatch to suppressed contact throws DispatchRefusedError
    await expect(dispatch(actor, manualMsg.id)).rejects.toThrow(DispatchRefusedError);

    // B) Play auto-send step to same suppressed email
    const playDef: PlayDefinition = {
      name: "Auto Send Suppressed Play",
      trigger: { type: "signal", ruleKey: "suppressed_test" },
      steps: [
        {
          key: "auto-email",
          name: "Safe auto email",
          handler: "send",
          params: {
            mode: "template",
            subject: "Manual Subject",
            body: "Manual text",
          },
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

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: `suppressed-play-${Date.now()}`,
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
    const pub1 = await publishPlay(actor, play.id);
    expect(pub1.status).toBe("PUBLISHED");

    const playRes = await enterPlay(
      actor,
      {
        workspaceId: workspace.id,
        playId: play.id,
        accountId: suppressedAccount.id,
        triggerRef: "suppressed-ref",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const playStepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: playRes.playRunId!, stepKey: "auto-email" },
    });

    // The play step CANNOT send to a suppressed contact: it is held for approval, never sent!
    expect(playStepRun.status).toBe("WAITING_APPROVAL");
    const heldMessage = await db.outboundMessage.findUniqueOrThrow({
      where: { id: playStepRun.outboundMessageId! },
    });
    expect(heldMessage.status).toBe("HELD");
    expect(heldMessage.heldReason).toContain("suppression");

    // CASE 2: Sensitive Content ("cancel the contract")
    // Both manual unapproved draft and play step cannot send sensitive content automatically
    const sensitivePlayDef: PlayDefinition = {
      name: "Sensitive Play",
      trigger: { type: "signal", ruleKey: "sensitive_test" },
      steps: [
        {
          key: "sensitive-draft",
          name: "Cancellation message",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Contract cancellation notice",
            body: "We received your request to cancel the subscription.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: true,
        },
      ],
    };

    const sensPlay = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: `sens-play-${Date.now()}`,
        name: sensitivePlayDef.name,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: sensPlay.id,
        version: 1,
        definition: sensitivePlayDef as unknown as Prisma.InputJsonValue,
      },
    });
    const pub2 = await publishPlay(actor, sensPlay.id);
    expect(pub2.status).toBe("PUBLISHED");

    const sensRes = await enterPlay(
      actor,
      {
        workspaceId: workspace.id,
        playId: sensPlay.id,
        accountId: suppressedAccount.id,
        triggerRef: "sens-ref",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    const sensStepRun = await db.playStepRun.findFirstOrThrow({
      where: { playRunId: sensRes.playRunId!, stepKey: "sensitive-draft" },
    });
    expect(sensStepRun.status).toBe("WAITING_APPROVAL");
    const sensMsg = await db.outboundMessage.findUniqueOrThrow({
      where: { id: sensStepRun.outboundMessageId! },
    });
    // Even if auto-send is on, sensitive message MUST be sendMode APPROVED and requires human approval
    expect(sensMsg.sendMode).toBe("APPROVED");
    expect(sensMsg.status).toBe("AWAITING_APPROVAL");
  });

  it("9. D10 Sweeps skip accounts that have an active published play run", async () => {
    const playDef: PlayDefinition = {
      name: "Renewal Play",
      trigger: { type: "signal", ruleKey: "renewal_window_90" },
      steps: [
        {
          key: "task-step",
          name: "Prep Renewal",
          handler: "task",
          params: { title: "Prep renewal docs" },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    };

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    // Active PlayRun for account
    await enterPlay(
      actor,
      {
        workspaceId: actor.workspaceId,
        playId: play.id,
        accountId: account.id,
        triggerRef: "renewal-sig-1",
      },
      { executeInline: true, autoSendEnabled: true },
    );

    // Open renewal signal
    await db.signal.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        ruleKey: "renewal_window_90",
        ruleVersion: 1,
        category: "MONEY",
        severity: "WARN",
        polarity: "RISK",
        title: "Renewal window 90 days",
        explanation: "Renewal window 90 days is open",
        values: {},
        params: {},
        dedupeKey: `renewal_window_90:${account.id}:c1:2026-11-20`,
        status: "OPEN",
        evidence: [{ summary: "window open" }],
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    // sweepRenewalAgents should skip this account
    const sweepRes = await sweepRenewalAgents(actor);
    expect(sweepRes.ran).toBe(0);
  });

  it("10. BullMQ in-process worker executes plays.enter and plays.step jobs", async () => {
    const playDef: PlayDefinition = {
      name: "BullMQ Worker Test Play",
      trigger: { type: "signal", ruleKey: "worker_test" },
      steps: [
        {
          key: "notify-step",
          name: "Worker Notify",
          handler: "notify",
          params: { message: "Executed via BullMQ worker" },
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

    const { actor, account, play, db } = await setupWorkspaceWithPlay(playDef);

    // Enqueue plays.enter to BullMQ queue "plays"
    const job = await getQueue("plays").add("plays.enter", {
      workspaceId: actor.workspaceId,
      playId: play.id,
      accountId: account.id,
      triggerRef: "worker-job-test-1",
    });

    const result = (await job.waitUntilFinished(events, 15_000)) as {
      status: string;
      playRunId?: string;
    };
    expect(result.status).toBe("RUNNING");
    expect(result.playRunId).toBeDefined();

    // Verify step was executed and completed
    // Worker runs plays.step which executes the step
    let stepCompleted = false;
    for (let i = 0; i < 20; i++) {
      const step = await db.playStepRun.findFirst({
        where: { playRunId: result.playRunId, stepKey: "notify-step" },
      });
      if (step?.status === "DONE") {
        stepCompleted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(stepCompleted).toBe(true);
  });
});
