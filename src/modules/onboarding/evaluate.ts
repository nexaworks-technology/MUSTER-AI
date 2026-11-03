import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { utcMidnight, type CalendarDate } from "@/lib/dates";
import { writeAudit } from "@/lib/audit";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { factsOf, loadPlanContexts, stepCondition } from "./facts";
import { detectStall, type OnboardingPlanFacts, type StallParams } from "./stall";
import { firstMet } from "./value";

/**
 * The nightly onboarding pass (M6 §2 `onboarding.evaluate`), run inside each signals chunk just
 * before the signal rules so they see today's completions. For each open plan:
 *  1. a step with a product condition completes when the usage rows prove it (D1: evidence kept);
 *  2. value is reached on the first date every value condition held (D3: evidence kept) and the
 *     plan becomes COMPLETE;
 *  3. otherwise the shared stall definition (D4) sets ACTIVE / STALLED with the likely blocker.
 * Nothing here writes a health score (M6 rule 5). Re-running a date changes nothing: every write
 * is guarded by a real change. Returns the facts the signal rules then read.
 */
export interface OnboardingEvaluation {
  stepsCompleted: number;
  valueReached: number;
  stalled: number;
  facts: Map<string, OnboardingPlanFacts>;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export async function evaluateOnboarding(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
  params: () => Promise<StallParams>,
): Promise<OnboardingEvaluation> {
  const db = scopedDb(ctx);
  const result: OnboardingEvaluation = {
    stepsCompleted: 0,
    valueReached: 0,
    stalled: 0,
    facts: new Map(),
  };
  const contexts = await loadPlanContexts(db, accountIds, asOf);
  if (contexts.size === 0) return result;
  const p = await params();
  const day = utcMidnight(asOf);

  for (const [accountId, c] of contexts) {
    const start = c.plan.startDate.toISOString().slice(0, 10);
    await db.$tenantTransaction(async (tx) => {
      // 1. Product-event completions (D1).
      for (const step of c.plan.steps) {
        const cond = step.doneAt ? null : stepCondition(step);
        const met = cond ? firstMet([cond], c.data, start, asOf) : null;
        if (!met) continue;
        const { count } = await tx.onboardingStep.updateMany({
          where: { id: step.id, doneAt: null },
          data: {
            doneAt: utcMidnight(met.date),
            completedVia: "PRODUCT_EVENT",
            evidence: json(met.evidence),
          },
        });
        if (!count) continue;
        step.doneAt = utcMidnight(met.date);
        result.stepsCompleted++;
        await writeAudit(
          {
            workspaceId: ctx.workspaceId,
            actorType: "SYSTEM",
            action: "onboarding.step_completed",
            targetType: "OnboardingStep",
            targetId: step.id,
            summary: `"${step.title}" completed by product usage on ${met.date}`,
            after: { evidence: met.evidence },
          },
          tx,
        );
      }

      // 2. Value reached (D3).
      if (!c.plan.valueReachedAt && c.valueDefinition.length) {
        const met = firstMet(c.valueDefinition, c.data, start, asOf);
        if (met) {
          await tx.onboardingPlan.update({
            where: { id: c.plan.id },
            data: {
              valueReachedAt: utcMidnight(met.date),
              valueEvidence: json(met.evidence),
              status: "COMPLETE",
              stallReason: null,
              blockers: [],
              lastEvaluatedOn: day,
            },
          });
          c.plan.valueReachedAt = utcMidnight(met.date);
          c.plan.status = "COMPLETE";
          result.valueReached++;
          await writeOutboxEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: "onboarding.valueReached",
            payload: { accountId, planId: c.plan.id, date: met.date },
          });
          await writeAudit(
            {
              workspaceId: ctx.workspaceId,
              actorType: "SYSTEM",
              action: "onboarding.value_reached",
              targetType: "OnboardingPlan",
              targetId: c.plan.id,
              summary: `First value reached on ${met.date}`,
              after: { evidence: met.evidence },
            },
            tx,
          );
          return;
        }
      }

      // 3. Stall status from the one definition (D4).
      const { facts } = factsOf(c, asOf);
      const r = detectStall(facts, p);
      const status = r.stalled ? "STALLED" : "ACTIVE";
      // jsonb reorders keys and drops undefined: compare structurally, through a JSON round trip.
      const changed =
        c.plan.status !== status ||
        c.plan.stallReason !== r.reason ||
        !isDeepStrictEqual(c.plan.blockers, JSON.parse(JSON.stringify(r.blockers)));
      if (!changed) return;
      await tx.onboardingPlan.update({
        where: { id: c.plan.id },
        data: { status, stallReason: r.reason, blockers: json(r.blockers), lastEvaluatedOn: day },
      });
      if (status === "STALLED" && c.plan.status !== "STALLED") {
        result.stalled++;
        await writeOutboxEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: "onboarding.stalled",
          payload: { accountId, planId: c.plan.id, reason: r.reason },
        });
      }
      c.plan.status = status;
    });
    if (c.plan.status !== "COMPLETE") result.facts.set(accountId, factsOf(c, asOf).plan);
  }
  return result;
}
