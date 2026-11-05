import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { Goal, Prisma, SuccessPlan, SuccessPlanStatus } from "@prisma/client";
import { writeAudit } from "@/lib/audit";

export interface SuccessPlanMilestone {
  id: string;
  title: string;
  targetDate?: string | null;
  completed: boolean;
  completedAt?: string | null;
}

export interface SuccessPlanView extends Omit<SuccessPlan, "milestones"> {
  milestones: SuccessPlanMilestone[];
  progressPercent: number;
}

export interface CreateSuccessPlanInput {
  accountId: string;
  title: string;
  status?: SuccessPlanStatus;
  sharedWithPortal?: boolean;
  milestones?: SuccessPlanMilestone[];
}

export interface UpdateSuccessPlanInput {
  title?: string;
  status?: SuccessPlanStatus;
  sharedWithPortal?: boolean;
  milestones?: SuccessPlanMilestone[];
}

export interface AccountSuccessPlanView {
  plan: SuccessPlanView;
  milestones: SuccessPlanMilestone[];
  progressPercent: number;
  goals: Goal[];
}

function calculateProgress(milestones: SuccessPlanMilestone[]): number {
  if (milestones.length === 0) return 0;
  const done = milestones.filter((m) => m.completed).length;
  return Math.round((done / milestones.length) * 100);
}

function toPlanView(plan: SuccessPlan): SuccessPlanView {
  const milestones = (Array.isArray(plan.milestones)
    ? plan.milestones
    : []) as unknown as SuccessPlanMilestone[];
  return {
    ...plan,
    milestones,
    progressPercent: calculateProgress(milestones),
  };
}

/**
 * Creates a success plan for an account. Audited with action "success_plan.created".
 */
export async function createSuccessPlan(
  ctx: TenantContext & { membershipId?: string },
  input: CreateSuccessPlanInput,
): Promise<SuccessPlanView> {
  const db = scopedDb(ctx);
  const milestones = input.milestones ?? [];

  return db.$tenantTransaction(async (tx) => {
    const plan = await tx.successPlan.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: input.accountId,
        title: input.title,
        status: input.status ?? "ACTIVE",
        sharedWithPortal: input.sharedWithPortal ?? false,
        milestones: milestones as unknown as Prisma.InputJsonValue,
      },
    });

    if (ctx.membershipId) {
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "USER",
          actorId: ctx.membershipId,
          action: "success_plan.created",
          targetType: "SuccessPlan",
          targetId: plan.id,
          summary: `Created success plan "${plan.title}"`,
          after: { title: plan.title, sharedWithPortal: plan.sharedWithPortal },
        },
        tx,
      );
    }

    return toPlanView(plan);
  });
}

/**
 * Updates a success plan. If sharedWithPortal changes, logs "success_plan.portal_sharing_changed".
 */
export async function updateSuccessPlan(
  ctx: TenantContext & { membershipId?: string },
  planId: string,
  input: UpdateSuccessPlanInput,
): Promise<SuccessPlanView> {
  const db = scopedDb(ctx);

  return db.$tenantTransaction(async (tx) => {
    const existing = await tx.successPlan.findUniqueOrThrow({
      where: { id: planId },
    });

    const isPortalToggle =
      input.sharedWithPortal !== undefined && input.sharedWithPortal !== existing.sharedWithPortal;

    const updated = await tx.successPlan.update({
      where: { id: planId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.sharedWithPortal !== undefined ? { sharedWithPortal: input.sharedWithPortal } : {}),
        ...(input.milestones !== undefined
          ? { milestones: input.milestones as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });

    if (ctx.membershipId) {
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "USER",
          actorId: ctx.membershipId,
          action: isPortalToggle ? "success_plan.portal_sharing_changed" : "success_plan.updated",
          targetType: "SuccessPlan",
          targetId: updated.id,
          summary: isPortalToggle
            ? `${updated.sharedWithPortal ? "Enabled" : "Disabled"} customer portal sharing for plan "${updated.title}"`
            : `Updated success plan "${updated.title}"`,
          before: { sharedWithPortal: existing.sharedWithPortal, title: existing.title },
          after: { sharedWithPortal: updated.sharedWithPortal, title: updated.title },
        },
        tx,
      );
    }

    return toPlanView(updated);
  });
}

/**
 * Retrieves the primary active success plan for an account, along with milestones and linked goals.
 */
export async function getAccountSuccessPlan(
  ctx: TenantContext,
  accountId: string,
): Promise<AccountSuccessPlanView | null> {
  const db = scopedDb(ctx);

  const plan = await db.successPlan.findFirst({
    where: { accountId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    include: {
      goals: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!plan) return null;

  const planView = toPlanView(plan);
  return {
    plan: planView,
    milestones: planView.milestones,
    progressPercent: planView.progressPercent,
    goals: plan.goals,
  };
}

/**
 * Links a goal to a success plan.
 */
export async function linkGoalToPlan(
  ctx: TenantContext,
  goalId: string,
  successPlanId: string | null,
): Promise<Goal> {
  const db = scopedDb(ctx);
  return db.goal.update({
    where: { id: goalId },
    data: { successPlanId },
  });
}
