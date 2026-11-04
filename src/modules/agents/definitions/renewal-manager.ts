import { z } from "zod";
import { addDays, businessClock, calendarDateOf, todayIn, type CalendarDate } from "@/lib/dates";
import type { ScopedDb, TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { requestApproval } from "@/modules/approvals/service";
import {
  attachBrief,
  briefMetrics,
  CUSTOMER_SAFE_KEYS,
  loadBriefFacts,
  RENEWAL_BRIEF_KEYS,
  renderNarrative,
  validateNarrative,
  type NarrativeBlock,
} from "@/modules/documents/service";
import { defineAgent } from "../define";
import {
  baseAgentOutput,
  proposedActionSchema,
  type ContextBundle,
  type ContextRecord,
} from "../schemas";
import { fallbackLeader, firstEmailContact } from "./draft-support";

/**
 * Renewal Manager (spec §6E8, M7 §2): for one renewal inside its window, a plan, a talk track, one
 * outreach draft and a next step with a date.
 *
 * Numbers (D-75): the model writes no digit. Every figure, date and count in its text is a
 * `{{metric.key}}` placeholder; the output schema refuses a digit or an unknown key (INVALID_OUTPUT),
 * code locks the metrics from records and fills the placeholders in, the outreach may carry only the
 * renewal date, and the next step's date is computed by code from the model's `timing`. The proposed
 * actions' confidence / ARR / estimate are overwritten from `facts` (forbiddenNumericFields).
 *
 * Effects (all idempotent by run): a Renewal Brief document carrying the narrative, an Approval for
 * the outreach (never sent: Rule 3), and an internal Task for the next step (no approval, Q-65).
 */
const NUMERIC = ["confidence", "arrAtRisk", "expansionEstimate"] as const;

export const renewalManagerInput = z.object({ renewalId: z.string().min(1) });
export type RenewalManagerInput = z.infer<typeof renewalManagerInput>;

const TIMINGS = ["within_a_week", "within_two_weeks", "before_notice_deadline"] as const;

export const renewalManagerOutput = z
  .object({
    ...baseAgentOutput.shape,
    proposedActions: z
      .array(
        proposedActionSchema.extend({
          arrAtRisk: z.number().optional(),
          expansionEstimate: z.number().optional(),
        }),
      )
      .default([]),
    planSteps: z
      .array(
        z.object({
          title: z.string().min(1).max(160),
          detail: z.string().min(1).max(400).nullable(),
        }),
      )
      .max(8),
    talkTrack: z.array(z.string().min(1).max(300)).max(8),
    outreach: z.object({
      subject: z.string().min(1).max(200).nullable(),
      body: z.string().min(1).max(4_000).nullable(),
    }),
    nextStep: z.object({ action: z.string().min(1).max(100), timing: z.enum(TIMINGS) }).nullable(),
  })
  .superRefine((o, ctx) => {
    const add = (problems: ReturnType<typeof validateNarrative>, path: string) => {
      for (const p of problems) ctx.addIssue({ code: "custom", message: p.message, path: [path] });
    };
    add(validateNarrative(internalBlocks(o), RENEWAL_BRIEF_KEYS), "narrative");
    add(validateNarrative(outreachBlocks(o), CUSTOMER_SAFE_KEYS), "outreach");
  });
export type RenewalManagerOutput = z.infer<typeof renewalManagerOutput>;

type Shaped = Pick<RenewalManagerOutput, "planSteps" | "talkTrack" | "outreach" | "nextStep">;

/** The internal narrative as blocks (also the Renewal Brief's narrative). */
export function internalBlocks(o: Shaped): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];
  if (o.planSteps.length) {
    blocks.push({ id: "plan-h", type: "heading", text: "Renewal plan" });
    o.planSteps.forEach((s, i) =>
      blocks.push({
        id: `plan-${i}`,
        type: "bullet",
        text: s.detail ? `${s.title}: ${s.detail}` : s.title,
      }),
    );
  }
  if (o.talkTrack.length) {
    blocks.push({ id: "talk-h", type: "heading", text: "Talk track" });
    o.talkTrack.forEach((t, i) => blocks.push({ id: `talk-${i}`, type: "bullet", text: t }));
  }
  if (o.nextStep)
    blocks.push({
      id: "next",
      type: "paragraph",
      text: `Next step: ${o.nextStep.action}, by {{metric.plan.nextStepDate}}.`,
    });
  return blocks;
}

/** The text that would go to the customer, held to the customer-safe placeholders. */
export function outreachBlocks(o: Shaped): NarrativeBlock[] {
  return [
    ...(o.outreach.subject
      ? [{ id: "subject", type: "paragraph" as const, text: o.outreach.subject }]
      : []),
    ...(o.outreach.body ? [{ id: "body", type: "paragraph" as const, text: o.outreach.body }] : []),
  ];
}

/** timing → the date, by code: never a number the model wrote. */
export function nextStepDate(
  timing: (typeof TIMINGS)[number],
  asOf: CalendarDate,
  noticeDeadline: CalendarDate | null,
): CalendarDate {
  if (timing === "within_two_weeks") return addDays(asOf, 14);
  if (timing === "before_notice_deadline" && noticeDeadline) {
    const d = addDays(noticeDeadline, -2);
    return d > asOf ? d : addDays(asOf, 1);
  }
  return addDays(asOf, 7);
}

export async function renewalManagerContext(
  db: ScopedDb,
  input: RenewalManagerInput,
  ctx: TenantContext,
) {
  const empty = {
    bundle: [] as ContextBundle,
    vars: { csmName: "the CSM", contactName: "the customer", accountName: "the account" },
  };
  const ws = await getOwnWorkspace(ctx);
  const asOf = todayIn(ws.timezone, businessClock);
  const loaded = await loadBriefFacts(db, input.renewalId, asOf);
  if (!loaded) return empty;
  const { facts, accountId, accountName } = loaded;
  const renewal = await db.renewal.findUniqueOrThrow({
    where: { id: input.renewalId },
    select: { stage: true, account: { select: { ownerMembershipId: true } } },
  });
  if (renewal.stage === "RENEWED" || renewal.stage === "CHURNED") return empty;
  const [owner, contact, goals] = await Promise.all([
    renewal.account.ownerMembershipId
      ? db.membership.findUnique({
          where: { id: renewal.account.ownerMembershipId },
          include: { user: { select: { name: true } } },
        })
      : Promise.resolve(null),
    firstEmailContact(db, accountId, null),
    db.goal.findMany({ where: { accountId }, select: { id: true, text: true, status: true } }),
  ]);
  const r = facts.renewal;
  const bundle: ContextBundle = [
    {
      sourceType: "Renewal",
      sourceId: r.id,
      fields: {
        account: accountName,
        renewalDate: r.dateText,
        noticeDeadline: r.noticeDeadlineText,
        daysToRenewal: r.daysTo,
        likelihoodBand: r.band.toLowerCase(),
      },
    },
    ...(facts.health
      ? [
          {
            sourceType: "HealthScoreSnapshot",
            sourceId: facts.health.snapshotId,
            fields: {
              band: facts.health.band.toLowerCase().replace("_", " "),
              ...Object.fromEntries(Object.entries(facts.health.parts).map(([k, v]) => [k, v])),
            },
          } satisfies ContextRecord,
        ]
      : []),
    ...facts.risks.map((s): ContextRecord => ({
      sourceType: "Signal",
      sourceId: s.id,
      fields: { title: s.title, severity: s.severity.toLowerCase() },
    })),
    ...goals.map((g): ContextRecord => ({
      sourceType: "Goal",
      sourceId: g.id,
      fields: { text: g.text, status: g.status.toLowerCase() },
    })),
    ...(facts.expansion
      ? [
          {
            sourceType: "ExpansionOpportunity",
            sourceId: facts.expansion.id,
            fields: { signals: facts.expansion.titles.join("; ") || null },
          } satisfies ContextRecord,
        ]
      : []),
    ...(contact
      ? [
          {
            sourceType: "Contact",
            sourceId: contact.id,
            fields: { name: contact.name, title: contact.title ?? null },
          } satisfies ContextRecord,
        ]
      : []),
  ];
  return {
    bundle,
    accountId,
    vars: {
      csmName: owner?.user.name ?? "the CSM",
      contactName: contact?.name ?? "the customer",
      accountName,
    },
    // The deterministic values that overwrite a model-supplied confidence / ARR / estimate.
    facts: {
      confidence: r.confidence,
      ...(r.arrMinor !== null ? { arrAtRisk: Number(r.arrMinor) } : {}),
      ...(facts.expansion?.estimateMinor != null
        ? { expansionEstimate: Number(facts.expansion.estimateMinor) }
        : {}),
    } as Record<string, number>,
  };
}

export const renewalManager = defineAgent({
  key: "renewal-manager",
  version: "1.0.0",
  description:
    "Builds the renewal plan, talk track, outreach draft and next step; the draft goes to Approvals, the next step becomes a Task",
  modelTier: "standard",
  tierReason:
    "A brief and one customer-facing draft from a few records: tone and accuracy matter (§6.1).",
  prompt: { name: "renewal-manager", version: "1.0.0" },
  inputSchema: renewalManagerInput,
  outputSchema: renewalManagerOutput,
  buildContext: renewalManagerContext,
  narrative: (o) => [
    o.reasoningSummary,
    ...internalBlocks(o).map((b) => b.text),
    ...outreachBlocks(o).map((b) => b.text),
  ],
  forbiddenNumericFields: NUMERIC,
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const renewalId = (ctx.input as RenewalManagerInput).renewalId;
    const effects: Array<{ type: string; id: string }> = [];
    const tctx = { workspaceId: ctx.workspaceId };
    const ws = await getOwnWorkspace(tctx);
    const asOf = todayIn(ws.timezone, businessClock);
    const loaded = await loadBriefFacts(ctx.db, renewalId, asOf);
    if (!loaded || !ctx.accountId) return { effects, actionTaken: "NONE" };
    const notice = loaded.facts.renewal.noticeDeadlineText
      ? calendarDateOf(
          (await ctx.db.renewal.findUniqueOrThrow({
            where: { id: renewalId },
            select: { noticeDeadline: true },
          }))!.noticeDeadline!,
        )
      : null;
    const due = output.nextStep ? nextStepDate(output.nextStep.timing, asOf, notice) : null;
    const facts = {
      ...loaded.facts,
      nextStep: due ? { dateText: due } : null,
    };

    // 1. The Renewal Brief, with this run's narrative on locked metrics.
    let doc = await ctx.db.document.findFirst({ where: { agentRunId: ctx.runId } });
    if (!doc)
      doc = await attachBrief(tctx, renewalId, { ...loaded, facts }, internalBlocks(output), {
        origin: "AI",
        agentRunId: ctx.runId,
      });
    effects.push({ type: "Document", id: doc.id });

    // 2. The outreach draft: customer-safe placeholders filled by code, then an Approval.
    const contact = ctx.bundle.find((r) => r.sourceType === "Contact");
    if (output.outreach.subject && output.outreach.body && contact) {
      const metrics = briefMetrics(facts);
      const [subject, body] = renderNarrative(outreachBlocks(output), metrics).map((b) => b.text);
      const approval = await requestApproval(ctx, {
        accountId: ctx.accountId,
        kind: "SEND_EMAIL",
        reason: `Renewal outreach for ${loaded.accountName}, renewing ${loaded.facts.renewal.dateText}`,
        proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
        proposedByAgentRunId: ctx.runId,
        triggeringText: [],
        sourceKey: ctx.sourceKey(0),
        email: {
          contactId: contact.sourceId,
          subject: subject!,
          body: body!,
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

    // 3. The next step: an internal Task with a code-computed date (no approval, Q-65).
    if (output.nextStep && due) {
      const account = await ctx.db.account.findUniqueOrThrow({
        where: { id: ctx.accountId },
        select: { ownerMembershipId: true },
      });
      const ownerId = account.ownerMembershipId ?? (await fallbackLeader(ctx.db));
      if (ownerId) {
        const existing = await ctx.db.task.findFirst({ where: { agentRunId: ctx.runId } });
        const title = `${output.nextStep.action} — by ${due}`.slice(0, 200);
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
              ruleKey: { in: ["renewal_window_90", "renewal_window_60", "renewal_window_30"] },
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
              detail: `From the renewal plan for ${loaded.accountName}.`,
              ownerMembershipId: ownerId,
              dueAt: new Date(`${due}T00:00:00Z`),
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
    return {
      effects,
      actionTaken: effects.some((e) => e.type === "Approval")
        ? "APPROVAL_REQUESTED"
        : effects.some((e) => e.type === "Task")
          ? "TASK_CREATED"
          : "DRAFTED",
    };
  },
});
