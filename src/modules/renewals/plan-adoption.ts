import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { validateNarrative, RENEWAL_BRIEF_KEYS, type NarrativeBlock } from "@/modules/documents/service";

export interface PlanStepInput {
  title: string;
  detail?: string | null;
  dueDate?: string | null;
}

export interface AdoptRenewalPlanInput {
  renewalId: string;
  steps: PlanStepInput[];
}

export class PlanAdoptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanAdoptionValidationError";
  }
}

/**
 * Human plan adoption into Renewal.planSteps (D-139, spec §6H2).
 *
 * Rules:
 * - Steps may be edited by the human before adoption.
 * - Every step's text is validated against the M7 placeholder rule (RENEWAL_BRIEF_KEYS).
 * - Adoption is audited with action "renewal.plan_adopted".
 * - No silent adoption: neither RenewalManager nor any background job automatically populates planSteps.
 */
export async function adoptRenewalPlan(actor: Actor, input: AdoptRenewalPlanInput) {
  requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);

  const renewal = await db.renewal.findUnique({
    where: { id: input.renewalId },
    include: {
      account: { select: { id: true, name: true } },
    },
  });
  if (!renewal) {
    throw new Error("Renewal not found.");
  }

  if (!input.steps || !Array.isArray(input.steps) || input.steps.length === 0) {
    throw new PlanAdoptionValidationError("At least one plan step is required to adopt a renewal plan.");
  }

  if (input.steps.length > 20) {
    throw new PlanAdoptionValidationError("Too many plan steps (maximum 20).");
  }

  // Validate each step using M7 placeholder rule
  for (let i = 0; i < input.steps.length; i++) {
    const s = input.steps[i]!;
    if (!s.title || s.title.trim().length === 0) {
      throw new PlanAdoptionValidationError(`Step ${i + 1} is missing a title.`);
    }

    const blocks: NarrativeBlock[] = [
      { id: `step-${i}-title`, type: "paragraph", text: s.title },
      ...(s.detail ? [{ id: `step-${i}-detail`, type: "paragraph" as const, text: s.detail }] : []),
    ];

    // Numbers are allowed for human-edited text, but placeholders must strictly follow M7 rules
    const problems = validateNarrative(blocks, RENEWAL_BRIEF_KEYS, {}, { numbers: "allow" });
    if (problems.length > 0) {
      throw new PlanAdoptionValidationError(
        `Step ${i + 1} validation failed: ${problems[0]?.message}`,
      );
    }
  }

  const cleanSteps = input.steps.map((s) => ({
    title: s.title.trim(),
    detail: s.detail?.trim() || null,
    dueDate: s.dueDate?.trim() || null,
    adoptedAt: new Date().toISOString(),
    adoptedByMembershipId: actor.membershipId,
  }));

  const updatedRenewal = await db.$tenantTransaction(async (tx) => {
    const updated = await tx.renewal.update({
      where: { id: renewal.id },
      data: {
        planSteps: cleanSteps,
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "renewal.plan_adopted",
        targetType: "Renewal",
        targetId: renewal.id,
        summary: `Adopted ${cleanSteps.length} renewal plan step(s) for ${renewal.account.name}`,
        after: {
          planStepsCount: cleanSteps.length,
          steps: cleanSteps.map((s) => ({ title: s.title, detail: s.detail })),
        },
      },
      tx,
    );

    return updated;
  });

  return {
    ok: true,
    steps: cleanSteps,
    renewal: updatedRenewal,
  };
}
