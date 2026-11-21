import type { Account, AccountTier, Prisma, TaskPriority } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { businessClock, type Clock } from "@/lib/dates";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { getQueue } from "@/lib/jobs/queues";
import { dispatch, detectSensitive, type DispatchDeps } from "@/modules/outbound/service";
import { getSettingsData } from "@/modules/settings/service";
import { approvalAssignee } from "@/modules/approvals/service";
import {
  adoptionCoach,
  expansionFinder,
  onboardingManager,
  renewalManager,
  runAgent,
  type ExecutorDeps,
  type RunOutcome,
} from "@/modules/agents/service";
import type { PlayBranch, PlayCondition, PlayDefinition, PlayStepDefinition } from "./definition";
import { checkRuntimeFrequencyCap } from "./runtime-cap";
import { resolvePlayStepLevel } from "./step-resolver";

export interface RunnerDeps {
  clock?: Clock;
  transport?: DispatchDeps["transport"];
  executeInline?: boolean;
  agentDeps?: ExecutorDeps;
  autoSendEnabled?: boolean;
}

export interface EnterPlayInput {
  workspaceId: string;
  playId: string;
  accountId: string;
  triggerRef: string;
  signalId?: string | null;
  isRetroactive?: boolean;
}

export interface EnterPlayResult {
  status: "RUNNING" | "COMPLETED" | "ALREADY_ENTERED" | "SKIPPED";
  playRunId?: string;
  reason?: string;
}

export interface ExecuteStepInput {
  workspaceId: string;
  playRunId: string;
  stepKey: string;
}

export interface ExecuteStepResult {
  status: "DONE" | "SKIPPED" | "WAITING_APPROVAL" | "WAITING" | "EXITED" | "FAILED";
  stepRunId?: string;
  approvalId?: string;
  taskId?: string;
  outboundMessageId?: string;
  reason?: string;
  scheduledFor?: Date;
}

async function getFirstLeaderOrAdmin(db: ScopedDb): Promise<string | null> {
  for (const role of ["CS_LEADER", "ADMIN"] as const) {
    const m = await db.membership.findFirst({
      where: { role, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (m) return m.id;
  }
  return null;
}

function evaluateCondition(account: Account, c: PlayCondition): boolean {
  const rawValue = (account as Record<string, unknown>)[c.field];
  switch (c.op) {
    case "eq":
      return rawValue === c.value;
    case "neq":
      return rawValue !== c.value;
    case "gt":
      return Number(rawValue) > Number(c.value);
    case "gte":
      return Number(rawValue) >= Number(c.value);
    case "lt":
      return Number(rawValue) < Number(c.value);
    case "lte":
      return Number(rawValue) <= Number(c.value);
    case "in":
      return Array.isArray(c.value) && c.value.includes(rawValue);
    case "contains":
      return typeof rawValue === "string" && rawValue.includes(String(c.value));
    case "isEmpty":
      return rawValue == null || rawValue === "";
    case "isNotEmpty":
      return rawValue != null && rawValue !== "";
    default:
      return true;
  }
}

function resolveBranchAndSteps(
  def: PlayDefinition,
  account: Account,
): { branch?: PlayBranch; steps: PlayStepDefinition[] } {
  if (def.branches && def.branches.length > 0) {
    for (const b of def.branches) {
      if (b.tier && b.tier !== account.tier) continue;
      if (b.steps && b.steps.length > 0) {
        return { branch: b, steps: b.steps };
      }
    }
  }
  return { steps: def.steps ?? [] };
}

function resolveRunSteps(def: PlayDefinition, run: { account?: { tier: AccountTier } | null }): PlayStepDefinition[] {
  if (run.account && def.branches && def.branches.length > 0) {
    const { steps } = resolveBranchAndSteps(def, run.account as unknown as Account);
    if (steps.length > 0) return steps;
  }
  return def.steps ?? [];
}

function mergePlaceholders(
  text: string,
  context: { account: { name: string }; contact?: { name: string; email?: string | null } | null; csm?: { name?: string | null; email?: string | null } | null },
): string {
  let result = text;
  result = result.replace(/\{\{account\.name\}\}/g, context.account.name ?? "");
  result = result.replace(/\{\{contact\.name\}\}/g, context.contact?.name ?? "");
  result = result.replace(/\{\{contact\.first_name\}\}/g, (context.contact?.name ?? "").split(" ")[0] ?? "");
  result = result.replace(/\{\{csm\.name\}\}/g, context.csm?.name ?? "Customer Success");
  result = result.replace(/\{\{csm\.email\}\}/g, context.csm?.email ?? "");
  return result;
}

/**
 * Enters an account into a published play (spec §5, ARCHITECTURE §3.2).
 * Idempotent per (playId, accountId, triggerRef) per D2; at most one OPEN run per play+account.
 */
export async function enterPlay(
  ctx: TenantContext,
  input: EnterPlayInput,
  deps: RunnerDeps = {},
): Promise<EnterPlayResult> {
  const db = scopedDb(ctx);
  const play = await db.play.findUnique({
    where: { id: input.playId },
    include: { currentVersion: true },
  });

  if (!play || play.status !== "PUBLISHED" || !play.currentVersion) {
    return { status: "SKIPPED", reason: "Play is not published" };
  }

  // Idempotency: exact duplicate trigger check (D2)
  const existingRun = await db.playRun.findUnique({
    where: {
      workspaceId_playId_accountId_triggerRef: {
        workspaceId: ctx.workspaceId,
        playId: input.playId,
        accountId: input.accountId,
        triggerRef: input.triggerRef,
      },
    },
  });
  if (existingRun) {
    return { status: "ALREADY_ENTERED", playRunId: existingRun.id };
  }

  // D2: At most one OPEN run per play+account; second trigger while open is ignored and logged
  const openRun = await db.playRun.findFirst({
    where: {
      playId: input.playId,
      accountId: input.accountId,
      status: { in: ["RUNNING", "WAITING"] },
    },
  });
  if (openRun) {
    logger.info(
      { playId: input.playId, accountId: input.accountId, triggerRef: input.triggerRef },
      "ignored trigger: play run is already open for this account",
    );
    return { status: "SKIPPED", reason: "Play run is already open for this account" };
  }

  const account = await db.account.findUnique({
    where: { id: input.accountId },
  });
  if (!account || account.archivedAt != null || account.lifecycleStage === "LOST") {
    return { status: "SKIPPED", reason: "Account is archived or lost" };
  }

  const def = play.currentVersion.definition as unknown as PlayDefinition;

  // Conditions check
  if (def.conditions && def.conditions.length > 0) {
    for (const c of def.conditions) {
      if (!evaluateCondition(account, c)) {
        return { status: "SKIPPED", reason: `Condition not met: ${c.field} ${c.op}` };
      }
    }
  }

  const { steps } = resolveBranchAndSteps(def, account);
  if (steps.length === 0) {
    const completedRun = await db.$tenantTransaction(async (tx) => {
      return tx.playRun.create({
        data: {
          workspaceId: ctx.workspaceId,
          playId: play.id,
          playVersionId: play.currentVersion!.id,
          accountId: account.id,
          triggerRef: input.triggerRef,
          signalId: input.signalId ?? null,
          status: "COMPLETED",
          exitedAt: (deps.clock ?? businessClock)(),
          exitReason: "No steps to run",
        },
      });
    });
    return { status: "COMPLETED", playRunId: completedRun.id };
  }

  const run = await db.$tenantTransaction(async (tx) => {
    const created = await tx.playRun.create({
      data: {
        workspaceId: ctx.workspaceId,
        playId: play.id,
        playVersionId: play.currentVersion!.id,
        accountId: account.id,
        triggerRef: input.triggerRef,
        signalId: input.signalId ?? null,
        status: "RUNNING",
      },
    });

    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: "SYSTEM",
        action: "play.entered",
        targetType: "PlayRun",
        targetId: created.id,
        summary: `Account "${account.name}" entered play "${play.name}"`,
        after: {
          playId: play.id,
          accountId: account.id,
          triggerRef: input.triggerRef,
          version: play.currentVersion!.version,
        },
      },
      tx,
    );
    return created;
  });

  const firstStep = steps[0]!;
  if (deps.executeInline) {
    await executeStep(
      ctx,
      { workspaceId: ctx.workspaceId, playRunId: run.id, stepKey: firstStep.key },
      deps,
    );
  } else {
    await getQueue("plays").add("plays.step", {
      workspaceId: ctx.workspaceId,
      playRunId: run.id,
      stepKey: firstStep.key,
    });
  }

  return { status: "RUNNING", playRunId: run.id };
}

/**
 * Executes a specific step within a play run (spec §5).
 * Safe, idempotent, and routes all customer sending through outbound.dispatch only.
 */
export async function executeStep(
  ctx: TenantContext,
  input: ExecuteStepInput,
  deps: RunnerDeps = {},
): Promise<ExecuteStepResult> {
  const db = scopedDb(ctx);
  const clock = deps.clock ?? businessClock;

  const run = await db.playRun.findUnique({
    where: { id: input.playRunId },
    include: {
      play: true,
      version: true,
      account: { select: { id: true, name: true, tier: true, ownerMembershipId: true, timezone: true, lifecycleStage: true, archivedAt: true } },
    },
  });

  if (!run) {
    return { status: "FAILED", reason: "Run not found" };
  }

  // Idempotency: step execution check
  const existingStepRun = await db.playStepRun.findUnique({
    where: {
      workspaceId_playRunId_stepKey: {
        workspaceId: ctx.workspaceId,
        playRunId: run.id,
        stepKey: input.stepKey,
      },
    },
  });

  if (existingStepRun && ["DONE", "SKIPPED", "WAITING_APPROVAL"].includes(existingStepRun.status)) {
    return {
      status: existingStepRun.status as ExecuteStepResult["status"],
      stepRunId: existingStepRun.id,
      approvalId: existingStepRun.approvalId ?? undefined,
      taskId: existingStepRun.taskId ?? undefined,
      outboundMessageId: existingStepRun.outboundMessageId ?? undefined,
    };
  }

  if (!["RUNNING", "WAITING"].includes(run.status)) {
    return { status: "FAILED", reason: `Run is ${run.status}` };
  }

  const def = run.version.definition as unknown as PlayDefinition;

  // Check exit conditions before step execution
  if (def.exitConditions && def.exitConditions.length > 0 && run.account) {
    for (const ec of def.exitConditions) {
      if (evaluateCondition(run.account as unknown as Account, ec)) {
        await db.playRun.update({
          where: { id: run.id },
          data: {
            status: "EXITED",
            exitedAt: clock(),
            exitReason: `Exit condition met: ${ec.field} ${ec.op}`,
          },
        });
        await writeAudit({
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "play.exited",
          targetType: "PlayRun",
          targetId: run.id,
          summary: `Play run exited: ${ec.field} ${ec.op}`,
        });
        return { status: "EXITED", reason: `Exit condition met: ${ec.field} ${ec.op}` };
      }
    }
  }

  const steps = resolveRunSteps(def, run);
  const step = steps.find((s) => s.key === input.stepKey);
  if (!step) {
    return { status: "FAILED", reason: `Step "${input.stepKey}" not found in definition` };
  }

  const stepRun =
    existingStepRun ??
    (await db.playStepRun.create({
      data: {
        workspaceId: ctx.workspaceId,
        playRunId: run.id,
        stepKey: step.key,
        handler: step.handler,
        status: "PENDING",
      },
    }));

  const account = run.account;
  const params = step.params ?? {};

  // Handlers
  switch (step.handler) {
    case "notify": {
      const recipientMembershipId =
        (params.recipientMembershipId as string | undefined) ??
        account?.ownerMembershipId ??
        (await getFirstLeaderOrAdmin(db));

      if (recipientMembershipId) {
        await db.notification.create({
          data: {
            workspaceId: ctx.workspaceId,
            recipientMembershipId,
            type: "SIGNAL_OPENED",
            title: (params.message as string) || `Play notification for ${account?.name ?? "account"}`,
            refType: "PlayRun",
            refId: run.id,
            accountId: account?.id ?? null,
          },
        });
      }

      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "DONE", result: { notified: true } },
      });
      await advanceToNextStep(ctx, run, steps, step.key, deps);
      return { status: "DONE", stepRunId: stepRun.id };
    }

    case "task": {
      const ownerMembershipId =
        (params.ownerMembershipId as string | undefined) ??
        account?.ownerMembershipId ??
        (await getFirstLeaderOrAdmin(db));

      const dueAt = params.dueDays
        ? new Date(clock().getTime() + Number(params.dueDays) * 86_400_000)
        : null;

      const task = await db.task.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: account?.id ?? null,
          signalId: run.signalId, // Q-48: link to signal
          title: (params.title as string) || `Play task: ${step.name}`,
          detail: (params.detail as string) || null,
          ownerMembershipId: ownerMembershipId ?? "",
          dueAt,
          priority: (params.priority as TaskPriority | undefined) ?? "NORMAL",
          origin: "SYSTEM",
        },
      });

      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "DONE", taskId: task.id, result: { taskId: task.id } },
      });
      await advanceToNextStep(ctx, run, steps, step.key, deps);
      return { status: "DONE", stepRunId: stepRun.id, taskId: task.id };
    }

    case "draft":
    case "send": {
      const mode = params.mode ?? (step.handler === "send" ? "template" : "agent");

      if (mode === "agent") {
        // D10: Delegate to existing M6/M7 agents for onboarding stall, adoption, renewal window, and expansion
        let agentRunOutcome: RunOutcome | undefined;
        const trigger = def.trigger;

        if (trigger.type === "signal" && trigger.ruleKey.startsWith("renewal_window")) {
          const renewal = await db.renewal.findFirst({
            where: { accountId: account?.id, stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
          });
          if (renewal) {
            agentRunOutcome = await runAgent(
              ctx,
              renewalManager,
              { renewalId: renewal.id },
              { type: "play", id: run.id },
              deps.agentDeps ?? {},
            );
          }
        } else if (trigger.type === "signal" && (trigger.ruleKey.includes("expansion") || trigger.ruleKey.includes("opportunity"))) {
          const opp = await db.expansionOpportunity.findFirst({
            where: { accountId: account?.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
          });
          if (opp) {
            agentRunOutcome = await runAgent(
              ctx,
              expansionFinder,
              { opportunityId: opp.id },
              { type: "play", id: run.id },
              deps.agentDeps ?? {},
            );
          }
        } else if (trigger.type === "event" && trigger.eventType === "onboarding.stalled") {
          const plan = await db.onboardingPlan.findFirst({
            where: { accountId: account?.id, status: "ACTIVE" },
          });
          if (plan) {
            agentRunOutcome = await runAgent(
              ctx,
              onboardingManager,
              { planId: plan.id, reason: "play_stall" },
              { type: "play", id: run.id },
              deps.agentDeps ?? {},
            );
          }
        } else if (
          trigger.type === "signal" &&
          ["seats_unused", "key_feature_stopped", "power_user_quiet", "usage_drop_vs_normal"].includes(trigger.ruleKey)
        ) {
          agentRunOutcome = await runAgent(
            ctx,
            adoptionCoach,
            { accountId: account!.id, reason: "signal" },
            { type: "play", id: run.id },
            deps.agentDeps ?? {},
          );
        }

        if (agentRunOutcome && agentRunOutcome.kind === "run") {
          const runId = agentRunOutcome.runId;
          const linkedApproval = await db.approval.findFirst({
            where: { proposedByAgentRunId: runId },
          });

          await db.playStepRun.update({
            where: { id: stepRun.id },
            data: {
              agentRunId: runId,
              approvalId: linkedApproval?.id ?? null,
              status: linkedApproval ? "WAITING_APPROVAL" : "DONE",
              result: { agentRunId: runId },
            },
          });

          if (linkedApproval) {
            await db.playRun.update({ where: { id: run.id }, data: { status: "WAITING" } });
            return {
              status: "WAITING_APPROVAL",
              stepRunId: stepRun.id,
              approvalId: linkedApproval.id,
            };
          } else {
            await advanceToNextStep(ctx, run, steps, step.key, deps);
            return { status: "DONE", stepRunId: stepRun.id };
          }
        } else {
          await db.playStepRun.update({
            where: { id: stepRun.id },
            data: { status: "DONE", result: { agentRun: "skipped_or_not_configured" } },
          });
          await advanceToNextStep(ctx, run, steps, step.key, deps);
          return { status: "DONE", stepRunId: stepRun.id };
        }
      }

      // Template mode
      const contact = await db.contact.findFirst({
        where: { accountId: account?.id, status: "ACTIVE" },
        orderBy: [{ createdAt: "asc" }],
      });

      if (!contact) {
        await db.playStepRun.update({
          where: { id: stepRun.id },
          data: { status: "SKIPPED", result: { reason: "No active contact" } },
        });
        await advanceToNextStep(ctx, run, steps, step.key, deps);
        return { status: "SKIPPED", stepRunId: stepRun.id, reason: "No active contact" };
      }

      // D1: Check runtime frequency cap
      const settings = await getSettingsData(ctx.workspaceId);
      const [lastToContact, lastToAccount] = await Promise.all([
        db.outboundMessage.findFirst({
          where: { contactId: contact.id, status: "SENT" },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        }),
        db.outboundMessage.findFirst({
          where: { accountId: account?.id, status: "SENT" },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        }),
      ]);

      const capResult = checkRuntimeFrequencyCap({
        now: clock(),
        contactCooldownHours: settings.outbound.contactCooldownHours,
        lastSentToContactAt: lastToContact?.sentAt ?? null,
        otherPlayCooldownHours: settings.outbound.otherPlayCooldownHours,
        lastOtherSendToAccountAt: lastToAccount?.sentAt ?? null,
      });

      if (capResult.breached) {
        // D1: A frequency-cap breach at run time makes the step SKIPPED with the reason recorded on the run.
        // Never queued, never sent. No task is created.
        await db.playStepRun.update({
          where: { id: stepRun.id },
          data: {
            status: "SKIPPED",
            result: { skippedReason: capResult.reason, guard: capResult.guard },
          },
        });
        await advanceToNextStep(ctx, run, steps, step.key, deps);
        return { status: "SKIPPED", stepRunId: stepRun.id, reason: capResult.reason };
      }

      const subject = mergePlaceholders((params.subject as string) || "Play notice", {
        account: account as Account,
        contact,
      });
      const bodyText = mergePlaceholders(
        (params.body as string) || (params.template as string) || "",
        { account: account as Account, contact },
      );

      const autoSendEnabled =
        deps.autoSendEnabled !== undefined
          ? deps.autoSendEnabled
          : settings.outbound.autoSendEnabled;

      const level = resolvePlayStepLevel({
        step,
        tier: account?.tier ?? "LONG_TAIL",
        workspaceCeiling: settings.approvals.workspaceCeiling,
        autoSendEnabled,
        isSensitive: step.sensitive,
      });

      if (level === "SEND_AUTOMATICALLY" && step.safe && !step.sensitive) {
        // D7: Record an Approval row (level SEND_AUTOMATICALLY, status AUTO_RECORDED, hidden from queues)
        // so dispatch's proof pre-check passes WITHOUT modifying dispatch.ts!
        const approval = await db.approval.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: account!.id,
            kind: "SEND_EMAIL",
            status: "AUTO_RECORDED",
            requiredLevel: "SEND_AUTOMATICALLY",
            proof: [{ sourceType: "Play", sourceId: run.play.id }],
            reason: `Play auto-send: ${run.play.name} - ${step.name}`,
            isSensitive: false,
            sensitiveReasons: [],
            sourceKey: `play:${run.id}:${step.key}`,
          },
        });

        const outboundMessage = await db.outboundMessage.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: account!.id,
            contactId: contact.id,
            approvalId: approval.id,
            toEmail: contact.email ?? "",
            subject,
            bodyText,
            sendMode: "AUTO",
            status: "AWAITING_APPROVAL",
            origin: "SYSTEM",
            signalId: run.signalId,
          },
        });

        // Single customer send choke point!
        const dispatchResult = await dispatch(ctx, outboundMessage.id, {
          clock,
          transport: deps.transport,
        });

        if (dispatchResult.status === "SENT") {
          await db.playStepRun.update({
            where: { id: stepRun.id },
            data: {
              status: "DONE",
              approvalId: approval.id,
              outboundMessageId: outboundMessage.id,
              result: { sent: true, providerMessageId: dispatchResult.providerMessageId },
            },
          });
          await advanceToNextStep(ctx, run, steps, step.key, deps);
          return {
            status: "DONE",
            stepRunId: stepRun.id,
            outboundMessageId: outboundMessage.id,
            approvalId: approval.id,
          };
        } else if (dispatchResult.status === "HELD") {
          // Held by guards -> convert AUTO_RECORDED approval to PENDING DRAFT_FOR_APPROVAL
          await db.approval.update({
            where: { id: dispatchResult.approvalId },
            data: {
              status: "PENDING",
              assigneeId: await approvalAssignee(ctx, account!.ownerMembershipId ?? null),
              requiredLevel: "DRAFT_FOR_APPROVAL",
              reason: `Held by the send guards: ${dispatchResult.heldReason}`,
            },
          });
          await db.playStepRun.update({
            where: { id: stepRun.id },
            data: {
              status: "WAITING_APPROVAL",
              approvalId: dispatchResult.approvalId,
              outboundMessageId: outboundMessage.id,
              result: { heldReason: dispatchResult.heldReason },
            },
          });
          await db.playRun.update({ where: { id: run.id }, data: { status: "WAITING" } });
          return {
            status: "WAITING_APPROVAL",
            stepRunId: stepRun.id,
            approvalId: dispatchResult.approvalId,
            outboundMessageId: outboundMessage.id,
          };
        }
      }

      // Human approval needed (e.g. DRAFT_FOR_APPROVAL)
      const sens = detectSensitive({ texts: [subject, bodyText] });
      const isSensitive = step.sensitive || sens.isSensitive;

      const approval = await db.approval.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: account!.id,
          kind: "SEND_EMAIL",
          status: "PENDING",
          requiredLevel: level,
          proof: [{ sourceType: "Play", sourceId: run.play.id }],
          reason: `Play draft: ${run.play.name} - ${step.name}`,
          // In the owner's queue like every other draft on the account (DEMO FAIL 24).
          assigneeId: await approvalAssignee(ctx, account!.ownerMembershipId ?? null),
          isSensitive,
          sensitiveReasons: isSensitive
            ? [...sens.reasons, ...(step.sensitive ? ["play_step_sensitive"] : [])]
            : [],
          sourceKey: `play:${run.id}:${step.key}`,
        },
      });

      const outboundMessage = await db.outboundMessage.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: account!.id,
          contactId: contact.id,
          approvalId: approval.id,
          toEmail: contact.email ?? "",
          subject,
          bodyText,
          sendMode: "APPROVED",
          status: "AWAITING_APPROVAL",
          origin: "SYSTEM",
          signalId: run.signalId,
        },
      });

      await db.draftRevision.create({
        data: {
          workspaceId: ctx.workspaceId,
          approvalId: approval.id,
          outboundMessageId: outboundMessage.id,
          version: 1,
          subject,
          bodyText,
        },
      });

      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: {
          status: "WAITING_APPROVAL",
          approvalId: approval.id,
          outboundMessageId: outboundMessage.id,
        },
      });
      await db.playRun.update({ where: { id: run.id }, data: { status: "WAITING" } });

      return {
        status: "WAITING_APPROVAL",
        stepRunId: stepRun.id,
        approvalId: approval.id,
        outboundMessageId: outboundMessage.id,
      };
    }

    case "update": {
      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "DONE", result: { updated: true } },
      });
      await advanceToNextStep(ctx, run, steps, step.key, deps);
      return { status: "DONE", stepRunId: stepRun.id };
    }

    case "escalate": {
      // Internal escalation Task per Q-65: no approval needed
      const leader = await getFirstLeaderOrAdmin(db);
      const ownerId = leader || account?.ownerMembershipId;

      const task = await db.task.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: account?.id ?? null,
          signalId: run.signalId, // Q-48
          title: (params.title as string) || `Escalation: Play ${run.play.name} for ${account?.name ?? "account"}`,
          detail: (params.detail as string) || `Play escalation triggered for account ${account?.name ?? ""}`,
          ownerMembershipId: ownerId ?? "",
          priority: "HIGH",
          origin: "SYSTEM",
        },
      });

      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "DONE", taskId: task.id, result: { taskId: task.id } },
      });
      await advanceToNextStep(ctx, run, steps, step.key, deps);
      return { status: "DONE", stepRunId: stepRun.id, taskId: task.id };
    }

    case "wait": {
      const durationHours =
        Number(params.durationHours ?? 0) + Number(params.durationDays ?? 0) * 24;
      const scheduledFor = new Date(clock().getTime() + durationHours * 3_600_000);

      if (clock() >= scheduledFor) {
        await db.playStepRun.update({
          where: { id: stepRun.id },
          data: { status: "DONE", result: { waitedHours: durationHours } },
        });
        await advanceToNextStep(ctx, run, steps, step.key, deps);
        return { status: "DONE", stepRunId: stepRun.id };
      } else {
        await db.playStepRun.update({
          where: { id: stepRun.id },
          data: { status: "PENDING", scheduledFor },
        });
        await db.playRun.update({ where: { id: run.id }, data: { status: "WAITING" } });
        return { status: "WAITING", stepRunId: stepRun.id, scheduledFor };
      }
    }

    case "exit": {
      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "DONE" },
      });
      await db.playRun.update({
        where: { id: run.id },
        data: {
          status: "EXITED",
          exitedAt: clock(),
          exitReason: (params.reason as string) || "Exit step executed",
        },
      });
      await writeAudit({
        workspaceId: ctx.workspaceId,
        actorType: "SYSTEM",
        action: "play.exited",
        targetType: "PlayRun",
        targetId: run.id,
        summary: `Play run exited via step ${step.name}`,
      });
      return { status: "EXITED", stepRunId: stepRun.id };
    }

    default:
      return { status: "FAILED", reason: `Unknown handler ${step.handler}` };
  }
}

async function advanceToNextStep(
  ctx: TenantContext,
  run: { id: string; play: { id: string }; version: { definition: Prisma.JsonValue } },
  steps: PlayStepDefinition[],
  currentStepKey: string,
  deps: RunnerDeps = {},
) {
  const db = scopedDb(ctx);
  const currentIndex = steps.findIndex((s) => s.key === currentStepKey);
  const nextStep = currentIndex >= 0 ? steps[currentIndex + 1] : undefined;

  if (nextStep) {
    await db.playRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    if (deps.executeInline) {
      await executeStep(
        ctx,
        { workspaceId: ctx.workspaceId, playRunId: run.id, stepKey: nextStep.key },
        deps,
      );
    } else {
      await getQueue("plays").add("plays.step", {
        workspaceId: ctx.workspaceId,
        playRunId: run.id,
        stepKey: nextStep.key,
      });
    }
  } else {
    // All steps complete
    await db.playRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        exitedAt: (deps.clock ?? businessClock)(),
      },
    });

    await writeAudit({
      workspaceId: ctx.workspaceId,
      actorType: "SYSTEM",
      action: "play.completed",
      targetType: "PlayRun",
      targetId: run.id,
      summary: `Play run completed all steps`,
    });
  }
}

/**
 * Resumes a waiting play step when an approval is decided (spec §5, ARCHITECTURE §3.2).
 */
export async function resumePlayRunOnApprovalDecided(
  ctx: TenantContext,
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  deps: RunnerDeps = {},
): Promise<{ resumed: boolean; next?: boolean; exited?: boolean; skipped?: boolean }> {
  const db = scopedDb(ctx);
  const clock = deps.clock ?? businessClock;

  const stepRun = await db.playStepRun.findFirst({
    where: { approvalId, status: "WAITING_APPROVAL" },
    include: {
      playRun: {
        include: {
          play: true,
          version: true,
          account: true,
        },
      },
    },
  });

  if (!stepRun) return { resumed: false };

  const run = stepRun.playRun;
  const def = run.version.definition as unknown as PlayDefinition;
  const steps = resolveRunSteps(def, run);

  if (decision === "APPROVED") {
    await db.playStepRun.update({
      where: { id: stepRun.id },
      data: { status: "DONE" },
    });
    await advanceToNextStep(ctx, run, steps, stepRun.stepKey, deps);
    return { resumed: true, next: true };
  } else {
    // REJECTED
    const stepDef = steps.find((s) => s.key === stepRun.stepKey);
    const onReject = (stepDef?.params?.onReject as string) || "exit";

    if (onReject === "skip") {
      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "SKIPPED", result: { rejected: true } },
      });
      await advanceToNextStep(ctx, run, steps, stepRun.stepKey, deps);
      return { resumed: true, skipped: true };
    } else {
      await db.playStepRun.update({
        where: { id: stepRun.id },
        data: { status: "SKIPPED", result: { rejected: true } },
      });
      await db.playRun.update({
        where: { id: run.id },
        data: {
          status: "EXITED",
          exitedAt: clock(),
          exitReason: "Approval rejected by human",
        },
      });
      return { resumed: true, exited: true };
    }
  }
}

/**
 * Sweep for stalled play runs waiting > stallDays for approval (spec §5, Q-65).
 * Creates an internal escalation Task (no approval needed).
 */
export async function sweepStalledPlayRuns(
  ctx: TenantContext,
  opts: { stallDays?: number; clock?: Clock } = {},
): Promise<{ escalated: number }> {
  const db = scopedDb(ctx);
  const clock = opts.clock ?? businessClock;
  const stallDays = opts.stallDays ?? 5;
  const cutoff = new Date(clock().getTime() - stallDays * 86_400_000);

  const stalledStepRuns = await db.playStepRun.findMany({
    where: {
      status: "WAITING_APPROVAL",
      createdAt: { lt: cutoff },
    },
    include: {
      playRun: {
        include: {
          account: { select: { id: true, name: true, ownerMembershipId: true } },
          play: { select: { id: true, name: true } },
        },
      },
    },
  });

  let escalated = 0;
  for (const sr of stalledStepRuns) {
    const existingEscalation = await db.task.findFirst({
      where: {
        accountId: sr.playRun.accountId,
        title: { startsWith: `Stalled Play: ${sr.playRun.play.name}` },
        status: "OPEN",
      },
    });
    if (existingEscalation) continue;

    const leader = await getFirstLeaderOrAdmin(db);
    const ownerId = sr.playRun.account.ownerMembershipId || leader;
    if (!ownerId) continue;

    await db.task.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: sr.playRun.accountId,
        signalId: sr.playRun.signalId, // Q-48
        title: `Stalled Play: ${sr.playRun.play.name} waiting on ${sr.stepKey}`,
        detail: `Play run ${sr.playRunId} for ${sr.playRun.account.name} has been stalled on step ${sr.stepKey} for more than ${stallDays} days.`,
        ownerMembershipId: ownerId,
        priority: "HIGH",
        origin: "SYSTEM",
      },
    });
    escalated++;
  }

  return { escalated };
}

export async function processPlayEnter(data: EnterPlayInput) {
  return enterPlay({ workspaceId: data.workspaceId }, data);
}

export async function processPlayStep(data: ExecuteStepInput) {
  return executeStep({ workspaceId: data.workspaceId }, data);
}

export async function processPlayApprovalDecided(data: {
  workspaceId: string;
  approvalId: string;
  status: "APPROVED" | "REJECTED";
}) {
  return resumePlayRunOnApprovalDecided(
    { workspaceId: data.workspaceId },
    data.approvalId,
    data.status,
  );
}

export async function processPlayNoteCreated(data: {
  workspaceId: string;
  noteId: string;
  accountId: string;
  tags?: string[];
}) {
  const db = scopedDb({ workspaceId: data.workspaceId });
  const plays = await db.play.findMany({
    where: { status: "PUBLISHED", currentVersionId: { not: null } },
    include: { currentVersion: true },
  });
  const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
  const entered: string[] = [];
  for (const play of plays) {
    if (!play.currentVersion) continue;
    const def = play.currentVersion.definition as unknown as PlayDefinition;
    if (def.trigger?.type === "noteTag" && tags.includes(def.trigger.tag)) {
      const res = await enterPlay(
        { workspaceId: data.workspaceId },
        {
          workspaceId: data.workspaceId,
          playId: play.id,
          accountId: data.accountId,
          triggerRef: `note:${data.noteId}:${def.trigger.tag}`,
        },
      );
      if (res.status === "RUNNING") entered.push(play.id);
    }
  }
  return { entered };
}

export async function processPlaySignalOpened(data: {
  workspaceId: string;
  accountId: string;
  signalId: string;
  ruleKey: string;
}) {
  const db = scopedDb({ workspaceId: data.workspaceId });
  const plays = await db.play.findMany({
    where: { status: "PUBLISHED", currentVersionId: { not: null } },
    include: { currentVersion: true },
  });
  const entered: string[] = [];
  for (const play of plays) {
    if (!play.currentVersion) continue;
    const def = play.currentVersion.definition as unknown as PlayDefinition;
    if (def.trigger?.type === "signal" && def.trigger.ruleKey === data.ruleKey) {
      const res = await enterPlay(
        { workspaceId: data.workspaceId },
        {
          workspaceId: data.workspaceId,
          playId: play.id,
          accountId: data.accountId,
          triggerRef: data.signalId,
          signalId: data.signalId,
        },
      );
      if (res.status === "RUNNING") entered.push(play.id);
    }
  }
  return { entered };
}

export async function processPlayEvent(data: {
  workspaceId: string;
  accountId: string;
  eventType?: string;
  documentId?: string;
  daysSinceLastQbr?: number;
  asOf?: string;
}) {
  const eventType = data.eventType ?? (data.documentId ? "business_review.followup" : "qbr.due");
  const db = scopedDb({ workspaceId: data.workspaceId });
  const plays = await db.play.findMany({
    where: { status: "PUBLISHED", currentVersionId: { not: null } },
    include: { currentVersion: true },
  });
  const entered: string[] = [];
  for (const play of plays) {
    if (!play.currentVersion) continue;
    const def = play.currentVersion.definition as unknown as PlayDefinition;
    if (def.trigger?.type === "event" && def.trigger.eventType === eventType) {
      const res = await enterPlay(
        { workspaceId: data.workspaceId },
        {
          workspaceId: data.workspaceId,
          playId: play.id,
          accountId: data.accountId,
          triggerRef: `${eventType}:${data.documentId ?? data.asOf ?? Date.now()}`,
        },
      );
      if (res.status === "RUNNING") entered.push(play.id);
    }
  }
  return { entered };
}

export async function processPlayStallSweep(data?: { workspaceId?: string }) {
  if (data?.workspaceId) {
    return sweepStalledPlayRuns({ workspaceId: data.workspaceId });
  }
  const out: Record<string, number> = {};
  for (const w of await listActiveWorkspaces()) {
    out[w.slug] = (await sweepStalledPlayRuns({ workspaceId: w.id })).escalated;
  }
  return out;
}

