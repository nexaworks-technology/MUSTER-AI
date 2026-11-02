import type { Prisma } from "@prisma/client";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { defaultParams, RULES } from "./rules/catalog";

/**
 * Signals module public surface (ARCHITECTURE §5). Signals are records with a lifecycle; the
 * rules that raise them are deterministic code (no AI in M3).
 */

/** One SignalRule row per catalogue rule (create only: a workspace's edits are never overwritten). */
export async function syncSignalRules(ctx: TenantContext): Promise<void> {
  const db = scopedDb(ctx);
  const existing = new Set(
    (await db.signalRule.findMany({ select: { ruleKey: true } })).map((r) => r.ruleKey),
  );
  const missing = RULES.filter((r) => !existing.has(r.key));
  if (missing.length === 0) return;
  await db.signalRule.createMany({
    data: missing.map((r) => ({
      workspaceId: ctx.workspaceId,
      ruleKey: r.key,
      category: r.category,
      polarity: r.polarity,
      enabled: !r.dormantReason,
      params: defaultParams(r.key) as Prisma.InputJsonValue,
      meaning: r.meaning,
      howDetected: r.howDetected,
      typicalLeadTime: r.typicalLeadTime,
      falseAlarmCauses: r.falseAlarmCauses,
      dormantReason: r.dormantReason ?? null,
    })),
    skipDuplicates: true,
  });
}
