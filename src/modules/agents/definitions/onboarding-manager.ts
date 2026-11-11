import { z } from "zod";
import { businessClock, calendarDateOf, daysBetween, todayIn } from "@/lib/dates";
import type { ScopedDb, TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { formatCalendarDate } from "@/lib/format";
import { requestApproval } from "@/modules/approvals/service";
import { defineAgent } from "../define";
import {
  baseAgentOutput,
  proposedActionSchema,
  type ContextBundle,
  type ContextRecord,
} from "../schemas";
import { fallbackLeader, firstEmailContact } from "./draft-support";
import { jobTier } from "@/lib/ai/routing";

/**
 * Onboarding Manager (spec §6E4, M6 §2): for one stalled or due onboarding plan, a check-in draft
 * to the customer contact behind the blocker and, when the owner should step in, an internal
 * escalation Task. The draft is an Approval at DRAFT_FOR_APPROVAL for every tier and never sends
 * (Rule 3); nothing here marks a step done (D-100).
 *
 * Numbers (D-75, M4 numbers rule): the model sets none. Days overdue, the plan day and every count
 * come from the plan's own records in the bundle; the narrative may only repeat what a cited record
 * says; the proposed-action numerics are overwritten from `facts`, and the escalation Task's title
 * is built by code from the same facts.
 */
const NUMERIC = ["confidence", "amountMinor", "days", "count", "percent"] as const;

export const onboardingManagerOutput = z.object({
  ...baseAgentOutput.shape,
  proposedActions: z
    .array(
      proposedActionSchema.extend({
        days: z.number().optional(),
        count: z.number().optional(),
        percent: z.number().optional(),
      }),
    )
    .default([]),
  subject: z.string().min(1).max(200).nullable(),
  body: z.string().min(1).max(4_000).nullable(),
  escalation: z.object({ needed: z.boolean(), note: z.string().min(1).max(400).nullable() }),
});
export type OnboardingManagerOutput = z.infer<typeof onboardingManagerOutput>;

export const onboardingManagerInput = z.object({
  planId: z.string().min(1),
  reason: z.enum(["stalled", "step_due"]),
});
export type OnboardingManagerInput = z.infer<typeof onboardingManagerInput>;

const day = (d: Date) => formatCalendarDate(d);
const blockerList = z
  .array(
    z.object({
      kind: z.string(),
      text: z.string(),
      days: z.number(),
      sources: z
        .array(z.object({ sourceType: z.string(), sourceId: z.string().optional() }))
        .default([]),
    }),
  )
  .catch([]);

/** A step is shown when it is overdue, or due within this many days. */
const DUE_SOON_DAYS = 3;

export async function onboardingManagerContext(
  db: ScopedDb,
  input: OnboardingManagerInput,
  ctx: TenantContext,
) {
  const empty = {
    bundle: [] as ContextBundle,
    vars: { csmName: "the CSM", contactName: "the customer", accountName: "the account" },
  };
  const plan = await db.onboardingPlan.findUnique({
    where: { id: input.planId },
    include: {
      steps: { orderBy: { position: "asc" } },
      account: { select: { id: true, name: true, tier: true, ownerMembershipId: true } },
    },
  });
  if (!plan || plan.status === "COMPLETE" || plan.status === "CANCELLED") return empty;
  const ws = await getOwnWorkspace(ctx);
  const asOf = todayIn(ws.timezone, businessClock);
  const dayOfPlan = daysBetween(calendarDateOf(plan.startDate), asOf);
  const blockers = blockerList.parse(plan.blockers);

  const open = plan.steps
    .filter((s) => s.doneAt === null)
    .map((s) => ({ s, overdue: daysBetween(calendarDateOf(s.dueDate), asOf) }))
    .filter(({ overdue }) => overdue > -DUE_SOON_DAYS)
    .sort((a, b) => b.overdue - a.overdue);
  const focus = open.find(({ s }) => s.ownerSide === "CUSTOMER") ?? open[0];

  const usageIds = [
    ...new Set(
      blockers
        .flatMap((b) => b.sources)
        .filter((x) => x.sourceType === "UsageDaily" && x.sourceId)
        .map((x) => x.sourceId!),
    ),
  ];
  const [usage, owner, contact] = await Promise.all([
    usageIds.length
      ? db.usageDaily.findMany({
          where: { id: { in: usageIds } },
          select: { id: true, date: true, activeUsers: true },
        })
      : Promise.resolve([]),
    plan.account.ownerMembershipId
      ? db.membership.findUnique({
          where: { id: plan.account.ownerMembershipId },
          include: { user: { select: { name: true } } },
        })
      : Promise.resolve(null),
    firstEmailContact(db, plan.accountId, focus?.s.ownerContactId ?? null),
  ]);

  const bundle: ContextBundle = [
    {
      sourceType: "OnboardingPlan",
      sourceId: plan.id,
      fields: {
        account: plan.account.name,
        status: plan.status.toLowerCase(),
        started: day(plan.startDate),
        targetValueDate: day(plan.targetValueDate),
        dayOfPlan,
        likelyBlocker: plan.stallReason,
        blockers: blockers.length ? blockers.map((b) => b.text).join("; ") : null,
        firstBlockerKind: blockers[0]?.kind ?? null,
        reason: input.reason === "stalled" ? "onboarding stalled" : "a step is due",
      },
    },
    { sourceType: "Account", sourceId: plan.account.id, fields: { name: plan.account.name } },
    ...open.map(({ s, overdue }): ContextRecord => ({
      sourceType: "OnboardingStep",
      sourceId: s.id,
      fields: {
        title: s.title,
        ownerSide: s.ownerSide === "US" ? "us" : "customer",
        dueDate: day(s.dueDate),
        daysOverdue: overdue > 0 ? overdue : null,
        blockedReason: s.blockedReason,
      },
    })),
    ...(contact
      ? [
          {
            sourceType: "Contact",
            sourceId: contact.id,
            fields: { name: contact.name, title: contact.title ?? null },
          },
        ]
      : []),
    ...usage.map((u) => ({
      sourceType: "UsageDaily",
      sourceId: u.id,
      fields: { date: day(u.date), activeUsers: u.activeUsers },
    })),
  ];
  const lead = blockers[0];
  return {
    bundle,
    accountId: plan.accountId,
    vars: {
      csmName: owner?.user.name ?? "the CSM",
      contactName: contact?.name ?? "the customer",
      accountName: plan.account.name,
    },
    facts: {
      ...(focus && focus.overdue > 0 ? { days: focus.overdue } : {}),
      dayOfPlan,
      ...(lead ? { blockerDays: lead.days } : {}),
    } as Record<string, number>,
  };
}

export const onboardingManager = defineAgent({
  key: "onboarding-manager",
  version: "1.0.0",
  description:
    "Drafts a check-in for a stalled or due onboarding step and asks the owner to step in; every draft goes to Approvals",
  modelTier: jobTier("onboarding-manager"),
  tierReason: "A short customer-facing draft from a few records: tone and accuracy matter (§6.1).",
  prompt: { name: "onboarding-manager", version: "1.0.0" },
  inputSchema: onboardingManagerInput,
  outputSchema: onboardingManagerOutput,
  buildContext: onboardingManagerContext,
  narrative: (o) => [o.subject ?? "", o.body ?? "", o.escalation.note ?? ""],
  forbiddenNumericFields: NUMERIC,
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const plan = ctx.bundle.find((r) => r.sourceType === "OnboardingPlan");
    if (!plan || !ctx.accountId) return { effects: [], actionTaken: "NONE" };
    const effects: Array<{ type: string; id: string }> = [];
    const ourSide = plan.fields.firstBlockerKind === "STEP_OVERDUE_US";
    const contact = ctx.bundle.find((r) => r.sourceType === "Contact");

    // A check-in only when the blocker is the customer's: our own delay is the owner's to fix.
    if (output.subject && output.body && contact && !ourSide) {
      const approval = await requestApproval(ctx, {
        accountId: ctx.accountId,
        kind: "SEND_EMAIL",
        reason: `Onboarding check-in: ${String(plan.fields.likelyBlocker ?? "onboarding is stalled")}`,
        proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
        proposedByAgentRunId: ctx.runId,
        triggeringText: [],
        sourceKey: ctx.sourceKey(0),
        email: {
          contactId: contact.sourceId,
          subject: output.subject,
          body: output.body,
          origin: "AI",
          agentRunId: ctx.runId,
        },
      });
      effects.push({ type: "Approval", id: approval.id });
      const message = await ctx.db.outboundMessage.findFirst({
        where: { approvalId: approval.id },
        select: { id: true },
      });
      if (message) effects.push({ type: "OutboundMessage", id: message.id });
    }

    // The escalation is internal: a Task for the account's owner (else a CS Leader), with a title
    // built from the plan's own words, not the model's.
    if (output.escalation.needed || ourSide) {
      const account = await ctx.db.account.findUniqueOrThrow({
        where: { id: ctx.accountId },
        select: { name: true, ownerMembershipId: true },
      });
      const ownerId = account.ownerMembershipId ?? (await fallbackLeader(ctx.db));
      if (ownerId) {
        const title =
          `Onboarding at ${account.name}: ${String(plan.fields.likelyBlocker ?? "needs attention")}`.slice(
            0,
            200,
          );
        const existing = await ctx.db.task.findFirst({ where: { agentRunId: ctx.runId } });
        let signalId: string | null = null;
        if (ctx.signalId) {
          const sig = await ctx.db.signal.findUnique({
            where: { id: ctx.signalId },
            select: { id: true },
          });
          if (sig) signalId = sig.id;
        }
        if (!signalId) {
          const bundleSigId = ctx.bundle.find((r) => r.sourceType === "Signal")?.sourceId;
          if (bundleSigId) {
            const sig = await ctx.db.signal.findUnique({
              where: { id: bundleSigId },
              select: { id: true },
            });
            if (sig) signalId = sig.id;
          }
        }
        if (!signalId) {
          const sig = await ctx.db.signal.findFirst({
            where: {
              accountId: ctx.accountId,
              ruleKey: {
                in: [
                  "onboarding_stall",
                  "onboarding_step_overdue_customer",
                  "onboarding_step_overdue_internal",
                  "onboarding_no_progress_7d",
                  "onboarding_ttv_behind_p75",
                ],
              },
              status: { in: ["OPEN", "ACKNOWLEDGED"] },
            },
            select: { id: true },
          });
          if (sig) signalId = sig.id;
        }
        const task =
          existing ??
          (await ctx.db.task.create({
            data: {
              workspaceId: ctx.workspaceId,
              accountId: ctx.accountId,
              signalId,
              title,
              detail: output.escalation.note,
              ownerMembershipId: ownerId,
              priority: "HIGH",
              origin: "AI",
              agentRunId: ctx.runId,
              source: "SYSTEM",
            },
          }));
        if (!existing)
          await ctx.db.notification.create({
            data: {
              workspaceId: ctx.workspaceId,
              recipientMembershipId: ownerId,
              type: "TASK_ASSIGNED",
              title: `New task: ${title}`.slice(0, 200),
              refType: "Task",
              refId: task.id,
              accountId: ctx.accountId,
            },
          });
        effects.push({ type: "Task", id: task.id });
      }
    }
    const drafted = effects.some((e) => e.type === "Approval");
    return {
      effects,
      actionTaken: drafted ? "APPROVAL_REQUESTED" : effects.length ? "TASK_CREATED" : "NONE",
    };
  },
});
