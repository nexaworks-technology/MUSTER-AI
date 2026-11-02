import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { utcMidnight } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { Aggregate } from "./engine/aggregate";
import { PILLARS } from "./engine/model";

/**
 * health.writeSnapshot(): the ONLY path that inserts HealthScoreSnapshot rows (ARCHITECTURE §4.4).
 * Zod refuses a score without proof before the database is touched; the database refuses it
 * again at commit (D-62). Snapshots are history: a same-day re-score under the same model version
 * replaces that day's row; another version writes its own row (founder condition B).
 */
const source = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().optional(),
  accountId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const reason = z.object({
  pillar: z.enum(PILLARS),
  component: z.string().min(1),
  kind: z.enum(["EVIDENCE", "MISSING_DATA"]),
  direction: z.enum(["UP", "DOWN", "NEUTRAL"]),
  impact: z.number(),
  score: z.number().nullable(),
  message: z.string().min(1),
  input: z.string().min(1),
  value: z.number().nullish(),
  baseline: z.number().nullish(),
  delta: z.number().nullish(),
  cohortValue: z.number().nullish(),
  cohortKey: z.string().nullish(),
  cohortSize: z.number().int().nullish(),
  periodStart: z.string().nullish(),
  periodEnd: z.string().nullish(),
  sources: z.array(source),
  sortOrder: z.number().int(),
});

const level = z.enum(["HEALTHY", "WATCH", "AT_RISK", "INSUFFICIENT_DATA"]);
const score = z.number().min(0).max(100).nullable();

export const snapshotDraft = z
  .object({
    accountId: z.string().min(1),
    healthModelId: z.string().min(1),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    isBacktest: z.boolean(),
    inputsHash: z.string().min(1),
    score: z.object({
      overall: score,
      overallExcludingPulse: score,
      pillars: z.object(
        Object.fromEntries(PILLARS.map((p) => [p, score])) as Record<
          (typeof PILLARS)[number],
          typeof score
        >,
      ),
      effectiveWeights: z.record(z.string(), z.number().nullable()),
      riskLevel: level,
      riskLevelExcludingPulse: level,
      riskReasonIndex: z.number().int().nullable(),
      reasons: z.array(reason),
      pulse: z.object({ id: z.string(), value: z.enum(["FINE", "WORRIED"]) }).nullable(),
      pulseDisagreement: z.boolean(),
    }),
  })
  .superRefine((d, ctx) => {
    const { score: s } = d;
    for (const p of PILLARS)
      if (s.pillars[p] !== null && !s.reasons.some((r) => r.pillar === p && r.kind === "EVIDENCE"))
        ctx.addIssue({ code: "custom", message: `${p} has a score but no evidence reason` });
    s.reasons.forEach((r, i) => {
      if (r.kind === "EVIDENCE" && r.sources.length === 0)
        ctx.addIssue({
          code: "custom",
          message: `Reason ${i} (${r.component}) needs at least one source`,
        });
    });
    if (s.riskLevel === "AT_RISK") {
      const r = s.riskReasonIndex === null ? undefined : s.reasons[s.riskReasonIndex];
      if (!r || r.kind !== "EVIDENCE")
        ctx.addIssue({ code: "custom", message: "At Risk needs an evidence reason" });
    }
  });

export type SnapshotDraft = Omit<z.infer<typeof snapshotDraft>, "score"> & { score: Aggregate };

export interface WriteResult {
  id: string;
  outcome: "CREATED" | "REPLACED" | "UNCHANGED";
}

const cols = {
  ADOPTION: "adoption",
  ENGAGEMENT: "engagement",
  SUPPORT: "support",
  RELATIONSHIP: "relationship",
  COMMERCIAL: "commercial",
  SENTIMENT: "sentiment",
} as const;

export async function writeSnapshot(
  db: ScopedDb,
  workspaceId: string,
  input: SnapshotDraft,
  opts: { makeCurrent?: boolean } = {},
): Promise<WriteResult> {
  const d = snapshotDraft.parse(input);
  const asOf = utcMidnight(d.asOf);
  return db.$tenantTransaction(async (tx) => {
    const existing = await tx.healthScoreSnapshot.findUnique({
      where: {
        workspaceId_accountId_healthModelId_asOf_isBacktest: {
          workspaceId,
          accountId: d.accountId,
          healthModelId: d.healthModelId,
          asOf,
          isBacktest: d.isBacktest,
        },
      },
      select: { id: true, inputsHash: true },
    });
    if (existing && existing.inputsHash === d.inputsHash) {
      if (opts.makeCurrent) await pointAccount(tx, workspaceId, d.accountId, existing.id);
      return { id: existing.id, outcome: "UNCHANGED" as const };
    }
    if (existing) {
      // Release the cache pointer before the row goes (NO ACTION FK), then replace it.
      await tx.$executeRaw`UPDATE "Account" SET "currentHealthSnapshotId" = NULL
        WHERE "workspaceId" = ${workspaceId} AND "currentHealthSnapshotId" = ${existing.id}`;
      await tx.healthScoreSnapshot.delete({ where: { id: existing.id } });
    }
    const id = randomUUID();
    const reasonIds = d.score.reasons.map(() => randomUUID());
    const s = d.score;
    await tx.healthScoreSnapshot.create({
      data: {
        id,
        workspaceId,
        accountId: d.accountId,
        healthModelId: d.healthModelId,
        asOf,
        isBacktest: d.isBacktest,
        inputsHash: d.inputsHash,
        overall: s.overall,
        overallExcludingPulse: s.overallExcludingPulse,
        ...Object.fromEntries(PILLARS.map((p) => [cols[p], s.pillars[p]])),
        riskLevel: s.riskLevel,
        riskLevelExcludingPulse: s.riskLevelExcludingPulse,
        riskReasonId: s.riskReasonIndex === null ? null : reasonIds[s.riskReasonIndex],
        pulseId: s.pulse?.id ?? null,
        pulseValue: s.pulse?.value ?? null,
        pulseDisagreement: s.pulseDisagreement,
        effectiveWeights: s.effectiveWeights,
      },
    });
    await tx.healthReason.createMany({
      data: s.reasons.map((r, i) => ({
        id: reasonIds[i]!,
        workspaceId,
        snapshotId: id,
        pillar: r.pillar,
        component: r.component,
        kind: r.kind,
        direction: r.direction,
        impact: r.impact,
        score: r.score,
        message: r.message,
        input: r.input,
        value: r.value ?? null,
        baseline: r.baseline ?? null,
        delta: r.delta ?? null,
        cohortValue: r.cohortValue ?? null,
        cohortKey: r.cohortKey ?? null,
        cohortSize: r.cohortSize ?? null,
        periodStart: r.periodStart ? utcMidnight(r.periodStart) : null,
        periodEnd: r.periodEnd ? utcMidnight(r.periodEnd) : null,
        sources: r.sources as Prisma.InputJsonValue,
        sortOrder: r.sortOrder,
      })),
    });
    if (opts.makeCurrent) await pointAccount(tx, workspaceId, d.accountId, id);
    return { id, outcome: existing ? ("REPLACED" as const) : ("CREATED" as const) };
  });
}

/**
 * The current-snapshot pointer is a cache (ARCHITECTURE §11). Raw SQL so Prisma's @updatedAt is
 * not bumped: a nightly re-score must not make an account look "recently updated" (D-49 staleness).
 */
function pointAccount(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  accountId: string,
  id: string,
) {
  return tx.$executeRaw`UPDATE "Account" SET "currentHealthSnapshotId" = ${id}
    WHERE "workspaceId" = ${workspaceId} AND id = ${accountId}`;
}
