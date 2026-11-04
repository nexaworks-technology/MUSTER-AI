import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { can, requirePermission } from "@/lib/auth/permissions";
import {
  addDays,
  businessClock,
  calendarDateOf,
  todayIn,
  utcMidnight,
  type Clock,
} from "@/lib/dates";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import {
  AccountNotFoundError,
  bookWhere,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { loadContext } from "@/modules/health/service";
import { factsOf, loadPlanContexts } from "./facts";
import { assembleHandoff, type HandoffInput } from "./handoff";
import {
  describeCondition,
  templateInput,
  templateStep,
  valueDefinition,
  type TemplateStep,
} from "./schemas";
import type { TtvResult } from "./ttv";

/**
 * Onboarding plans, steps and templates (spec §6G1, M6 §2). Plans are created from a template
 * chosen by the account's plan, then tier. A step is done by a person (HUMAN, audited) or by a
 * product event in the nightly pass (D1); never by a date passing. Book scope applies to every
 * read; edits need `accounts:edit` in the book; templates need `plays:publish` (Admin, CS Leader).
 */
export class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingError";
  }
}

const json = (v: unknown) => v as Prisma.InputJsonValue;
const PAGE = 25;
const today = async (actor: Actor, clock: Clock) =>
  todayIn((await loadContext(actor)).timeZone, clock);

// ─── Templates ───────────────────────────────────────────────────────────────

/** Feature names as the catalogue labels them, so conditions read "Data connectors", not keys. */
async function featureLabels(db: ScopedDb): Promise<Record<string, string>> {
  const catalog = await db.featureCatalog.findMany({ select: { featureKey: true, label: true } });
  return Object.fromEntries(catalog.map((f) => [f.featureKey, f.label]));
}

export async function listTemplates(actor: Actor, opts: { includeArchived?: boolean } = {}) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const [rows, labels] = await Promise.all([
    db.onboardingTemplate.findMany({
      where: opts.includeArchived ? {} : { archivedAt: null },
      orderBy: { name: "asc" },
    }),
    featureLabels(db),
  ]);
  return rows.map((t) => {
    const steps = z.array(templateStep).safeParse(t.steps);
    const value = valueDefinition.safeParse(t.valueDefinition);
    return {
      ...t,
      steps: steps.success ? steps.data : [],
      valueDefinition: value.success ? value.data : [],
      valueText:
        value.success && value.data.length
          ? value.data.map((c) => describeCondition(c, labels)).join(" and ")
          : null,
    };
  });
}

export async function saveTemplate(actor: Actor, raw: unknown, templateId?: string) {
  requirePermission(actor, "plays:publish");
  const input = templateInput.parse(raw);
  const db = scopedDb(actor);
  return db.$tenantTransaction(async (tx) => {
    const before = templateId
      ? await tx.onboardingTemplate.findUnique({ where: { id: templateId } })
      : null;
    if (templateId && !before) throw new OnboardingError("This template does not exist.");
    const data = {
      name: input.name,
      forTier: input.forTier,
      forPlan: input.forPlan,
      targetDays: input.targetDays,
      steps: json(input.steps),
      valueDefinition: json(input.valueDefinition),
    };
    const row = before
      ? await tx.onboardingTemplate.update({ where: { id: before.id }, data })
      : await tx.onboardingTemplate.create({ data: { workspaceId: actor.workspaceId, ...data } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: before ? "onboarding.template_updated" : "onboarding.template_created",
        targetType: "OnboardingTemplate",
        targetId: row.id,
        summary: `${before ? "Updated" : "Created"} onboarding template "${row.name}"`,
        before: before
          ? {
              targetDays: before.targetDays,
              steps: before.steps,
              valueDefinition: before.valueDefinition,
            }
          : undefined,
        after: data,
      },
      tx,
    );
    return row;
  });
}

export async function archiveTemplate(actor: Actor, templateId: string) {
  requirePermission(actor, "plays:publish");
  const db = scopedDb(actor);
  const { count } = await db.onboardingTemplate.updateMany({
    where: { id: templateId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (!count) throw new OnboardingError("This template does not exist.");
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "onboarding.template_archived",
    targetType: "OnboardingTemplate",
    targetId: templateId,
    summary: "Archived an onboarding template (existing plans keep their steps)",
  });
}

// ─── Plans ───────────────────────────────────────────────────────────────────

/** The template for an account: its plan first, then its tier, then a general one. */
export function chooseTemplate<
  T extends { forPlan: string | null; forTier: string | null; archivedAt: Date | null },
>(templates: T[], account: { tier: string; plan: string | null }): T | null {
  const live = templates.filter((t) => !t.archivedAt);
  return (
    live.find(
      (t) => t.forPlan && t.forPlan === account.plan && (!t.forTier || t.forTier === account.tier),
    ) ??
    live.find((t) => !t.forPlan && t.forTier === account.tier) ??
    live.find((t) => !t.forPlan && !t.forTier) ??
    null
  );
}

export async function createPlan(
  actor: Actor,
  accountId: string,
  opts: { templateId?: string; startDate?: string } = {},
  clock: Clock = businessClock,
) {
  const account = await requireEditableAccount(actor, accountId);
  const db = scopedDb(actor);
  const templates = await db.onboardingTemplate.findMany({ where: { archivedAt: null } });
  const template = opts.templateId
    ? templates.find((t) => t.id === opts.templateId)
    : chooseTemplate(templates, { tier: account.tier, plan: account.plan ?? null });
  if (!template)
    throw new OnboardingError(
      "There is no onboarding template for this account yet. Add one in Settings › Onboarding templates.",
    );
  const steps = z.array(templateStep).parse(template.steps);
  const start = opts.startDate ? z.iso.date().parse(opts.startDate) : await today(actor, clock);
  const owner = (
    await db.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { ownerMembershipId: true },
    })
  ).ownerMembershipId;
  return db.$tenantTransaction(async (tx) => {
    if (
      await tx.onboardingPlan.findFirst({
        where: { accountId, status: { in: ["ACTIVE", "STALLED"] } },
      })
    )
      throw new OnboardingError("This account already has an open onboarding plan.");
    const plan = await tx.onboardingPlan.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId,
        templateId: template.id,
        startDate: utcMidnight(start),
        targetValueDate: utcMidnight(addDays(start, template.targetDays)),
      },
    });
    await tx.onboardingStep.createMany({
      data: steps.map((s: TemplateStep, i) => ({
        workspaceId: actor.workspaceId,
        planId: plan.id,
        key: s.key,
        position: i + 1,
        title: s.title,
        ownerSide: s.ownerSide,
        ownerMembershipId: s.ownerSide === "US" ? owner : null,
        dueDate: utcMidnight(addDays(start, s.dueDay)),
        completesWhen: s.completesWhen ? json(s.completesWhen) : undefined,
      })),
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "onboarding.plan_created",
        targetType: "OnboardingPlan",
        targetId: plan.id,
        summary: `Started onboarding from "${template.name}" (${steps.length} steps, value expected by day ${template.targetDays})`,
      },
      tx,
    );
    return plan;
  });
}

// ─── Steps (D1: a person, or a product event in the nightly pass) ────────────

async function editableStep(actor: Actor, stepId: string) {
  const step = await scopedDb(actor).onboardingStep.findUnique({
    where: { id: stepId },
    include: { plan: { select: { accountId: true, status: true } } },
  });
  if (!step) throw new OnboardingError("This step does not exist.");
  await requireEditableAccount(actor, step.plan.accountId);
  return step;
}

export async function markStepDone(actor: Actor, stepId: string, clock: Clock = businessClock) {
  const step = await editableStep(actor, stepId);
  if (step.doneAt) throw new OnboardingError("This step is already done.");
  const day = await today(actor, clock);
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    await tx.onboardingStep.update({
      where: { id: step.id },
      data: {
        doneAt: utcMidnight(day),
        completedVia: "HUMAN",
        completedByMembershipId: actor.membershipId,
        blockedReason: null,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "onboarding.step_completed",
        targetType: "OnboardingStep",
        targetId: step.id,
        summary: `Marked "${step.title}" done`,
      },
      tx,
    );
  });
}

export const stepPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  dueDate: z.iso.date().optional(),
  blockedReason: z.string().trim().max(200).nullable().optional(),
  ownerMembershipId: z.string().min(1).nullable().optional(),
  ownerContactId: z.string().min(1).nullable().optional(),
});

export async function updateStep(actor: Actor, stepId: string, raw: unknown) {
  const step = await editableStep(actor, stepId);
  const patch = stepPatch.parse(raw);
  const data: Prisma.OnboardingStepUncheckedUpdateInput = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.dueDate !== undefined) data.dueDate = utcMidnight(patch.dueDate);
  if (patch.blockedReason !== undefined) data.blockedReason = patch.blockedReason || null;
  if (patch.ownerMembershipId !== undefined && step.ownerSide === "US")
    data.ownerMembershipId = patch.ownerMembershipId;
  if (patch.ownerContactId !== undefined && step.ownerSide === "CUSTOMER")
    data.ownerContactId = patch.ownerContactId;
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    await tx.onboardingStep.update({ where: { id: step.id }, data });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "onboarding.step_updated",
        targetType: "OnboardingStep",
        targetId: step.id,
        summary: `Updated "${step.title}"`,
        before: { title: step.title, dueDate: step.dueDate, blockedReason: step.blockedReason },
        after: patch,
      },
      tx,
    );
  });
}

export async function addStep(
  actor: Actor,
  planId: string,
  raw: unknown,
  clock: Clock = businessClock,
) {
  const plan = await scopedDb(actor).onboardingPlan.findUnique({
    where: { id: planId },
    include: { steps: true },
  });
  if (!plan) throw new OnboardingError("This plan does not exist.");
  await requireEditableAccount(actor, plan.accountId);
  const s = templateStep
    .extend({ dueDate: z.iso.date().optional() })
    .omit({ dueDay: true })
    .parse(raw);
  if (plan.steps.some((x) => x.key === s.key))
    throw new OnboardingError("This plan already has a step with that key.");
  const due = s.dueDate ?? addDays(await today(actor, clock), 7);
  const owner =
    s.ownerSide === "US"
      ? (await scopedDb(actor).account.findUniqueOrThrow({ where: { id: plan.accountId } }))
          .ownerMembershipId
      : null;
  return scopedDb(actor).onboardingStep.create({
    data: {
      workspaceId: actor.workspaceId,
      planId,
      key: s.key,
      position: plan.steps.length + 1,
      title: s.title,
      ownerSide: s.ownerSide,
      ownerMembershipId: owner,
      dueDate: utcMidnight(due),
    },
  });
}

export async function removeStep(actor: Actor, stepId: string) {
  const step = await editableStep(actor, stepId);
  if (step.doneAt) throw new OnboardingError("A done step stays on the plan as a record.");
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    await tx.onboardingStep.delete({ where: { id: step.id } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "onboarding.step_removed",
        targetType: "OnboardingStep",
        targetId: step.id,
        summary: `Removed "${step.title}" from the plan`,
      },
      tx,
    );
  });
}

// ─── Read models ─────────────────────────────────────────────────────────────

export const onboardingListQuery = z.object({
  tier: z.enum(["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"]).optional(),
  owner: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export interface OnboardingRow {
  planId: string;
  account: { id: string; name: string; tier: string };
  owner: string | null;
  day: number;
  status: "ACTIVE" | "STALLED";
  blocker: string | null;
  ttv: TtvResult | null;
}

/**
 * /onboarding: every account with an open plan in the member's book, stalled first, then by day.
 * A fixed number of queries per page (acceptance #13).
 */
export async function listOnboarding(
  actor: Actor,
  raw: unknown = {},
  clock: Clock = businessClock,
) {
  const grant = requirePermission(actor, "accounts:view");
  const q = onboardingListQuery.parse(raw);
  const db = scopedDb(actor);
  const where: Prisma.OnboardingPlanWhereInput = {
    status: { in: ["ACTIVE", "STALLED"] },
    account: {
      AND: [
        bookWhere(actor, grant.scope),
        q.tier ? { tier: q.tier } : {},
        q.owner ? { ownerMembershipId: q.owner } : {},
      ],
    },
  };
  const asOf = await today(actor, clock);
  const [total, plans] = await Promise.all([
    db.onboardingPlan.count({ where }),
    db.onboardingPlan.findMany({
      where,
      orderBy: [{ status: "desc" }, { startDate: "asc" }, { id: "asc" }],
      skip: (q.page - 1) * PAGE,
      take: PAGE,
      select: {
        id: true,
        status: true,
        stallReason: true,
        startDate: true,
        account: {
          select: {
            id: true,
            name: true,
            tier: true,
            owner: { select: { user: { select: { name: true, email: true } } } },
          },
        },
      },
    }),
  ]);
  const contexts = await loadPlanContexts(
    db,
    plans.map((p) => p.account.id),
    asOf,
  );
  const rows: OnboardingRow[] = plans.map((p) => {
    const c = contexts.get(p.account.id);
    return {
      planId: p.id,
      account: { id: p.account.id, name: p.account.name, tier: p.account.tier },
      owner: p.account.owner?.user.name ?? p.account.owner?.user.email ?? null,
      day: Math.max(
        0,
        Math.round((utcMidnight(asOf).getTime() - p.startDate.getTime()) / 86_400_000),
      ),
      status: p.status as "ACTIVE" | "STALLED",
      blocker: p.stallReason,
      ttv: c ? factsOf(c, asOf).plan.ttv : null,
    };
  });
  return { rows, total, page: q.page, pages: Math.max(1, Math.ceil(total / PAGE)), asOf };
}

/** Account 360 › Onboarding: the plan (open or latest), its steps with owners, TTV, handoff. */
export async function getAccountOnboarding(
  actor: Actor,
  accountId: string,
  clock: Clock = businessClock,
) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const db = scopedDb(actor);
  const asOf = await today(actor, clock);
  const plan = await db.onboardingPlan.findFirst({
    where: { accountId },
    orderBy: { startDate: "desc" },
    include: {
      template: { select: { name: true, valueDefinition: true } },
      steps: {
        orderBy: { position: "asc" },
        include: {
          owner: { select: { user: { select: { name: true, email: true } } } },
          ownerContact: { select: { name: true } },
          completedBy: { select: { user: { select: { name: true, email: true } } } },
        },
      },
    },
  });
  const [handoff, contexts, labels] = await Promise.all([
    loadHandoff(actor, accountId, asOf),
    plan ? loadPlanContexts(db, [accountId], asOf, [plan.id]) : Promise.resolve(new Map()),
    featureLabels(db),
  ]);
  const ctx = contexts.get(accountId);
  const def = valueDefinition.safeParse(plan?.template?.valueDefinition ?? []);
  return {
    asOf,
    canEdit: account.canEdit,
    plan,
    valueText:
      def.success && def.data.length
        ? def.data.map((c) => describeCondition(c, labels)).join(" and ")
        : null,
    ttv: ctx ? factsOf(ctx, asOf).plan.ttv : null,
    labels,
    handoff,
  };
}

/** The handoff from records (handoff.ts), read live so it always shows the current sources. */
export async function loadHandoff(actor: Actor, accountId: string, asOf: string) {
  const db = scopedDb(actor);
  const day = utcMidnight(asOf);
  const [contract, roles, goals, risks, kickoff, promises] = await Promise.all([
    db.contract.findFirst({
      where: { accountId, status: "ACTIVE", startDate: { lte: day } },
      orderBy: { startDate: "desc" },
    }),
    db.stakeholderRole.findMany({
      where: {
        accountId,
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
      },
      include: { contact: { select: { id: true, name: true, title: true } } },
      orderBy: { validFrom: "desc" },
    }),
    db.goal.findMany({ where: { accountId, status: "OPEN" }, orderBy: { createdAt: "asc" } }),
    db.signal.findMany({
      where: { accountId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      select: { id: true, title: true, severity: true },
      take: 10,
    }),
    db.note.findFirst({
      where: {
        accountId,
        OR: [{ tags: { has: "kickoff" } }, { template: { callType: "kickoff" } }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    }),
    // M9: our side's promises (Sales's included), from the Promise Tracker's rows.
    db.promise.findMany({
      where: { accountId, party: { in: ["US", "UNCLEAR"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const crm = contract
    ? await db.externalRef.findFirst({
        where: {
          internalType: "Contract",
          internalId: contract.id,
          source: { in: ["HUBSPOT", "SALESFORCE"] },
        },
        select: { source: true, objectType: true, externalId: true },
      })
    : null;
  const input: HandoffInput = {
    showMoney: can(actor, "revenue:view") !== null,
    contract: contract
      ? {
          id: contract.id,
          startDate: calendarDateOf(contract.startDate),
          valueMinor: contract.valueMinor,
          currency: contract.currency,
          seatsPurchased: contract.seatsPurchased,
          renewalDate: contract.renewalDate ? calendarDateOf(contract.renewalDate) : null,
          crm: crm
            ? {
                source: crm.source === "HUBSPOT" ? "HubSpot" : "Salesforce",
                objectType: crm.source === "HUBSPOT" ? "deal" : "opportunity",
                externalId: crm.externalId,
              }
            : null,
        }
      : null,
    roles: roles.map((r) => ({
      id: r.id,
      role: r.role,
      contactId: r.contact.id,
      contactName: r.contact.name,
      title: r.contact.title,
    })),
    goals: goals.map((g) => ({
      id: g.id,
      text: g.text,
      sourceType: g.sourceType,
      sourceId: g.sourceId,
      quote: g.quote,
      origin: g.origin,
    })),
    promises: promises.map((p) => ({
      id: p.id,
      what: p.what,
      party: p.party,
      status: p.status,
      dueDate: p.dueDate ? calendarDateOf(p.dueDate) : null,
      quote: p.quote,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
    })),
    risks,
    kickoffNote: kickoff ? { id: kickoff.id, date: calendarDateOf(kickoff.createdAt) } : null,
  };
  return assembleHandoff(input);
}
