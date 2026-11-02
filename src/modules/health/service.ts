import type { HealthModel } from "@prisma/client";
import type { CalendarDate } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { inputsHash, scoreBundle, type Aggregate } from "./engine";
import {
  DEFAULT_COMPONENT_CONFIG,
  DEFAULT_MODEL,
  DEFAULT_PARAMS,
  DEFAULT_PILLAR_WEIGHTS,
  DEFAULT_THRESHOLDS,
  modelConfigSchema,
  type ModelConfig,
} from "./engine/model";
import type { AccountBundle } from "./engine/types";
import { loadBundles, type LoadContext } from "./loader";
import { writeSnapshot, type WriteResult } from "./snapshots";

/**
 * Health module public surface (ARCHITECTURE §4). Every number comes from the deterministic
 * engine over real records; this module never calls an AI provider (health-no-ai.test.ts).
 */
export async function loadContext(ctx: TenantContext): Promise<LoadContext> {
  const ws = await getOwnWorkspace(ctx);
  return { workspaceId: ws.id, timeZone: ws.timezone, baseCurrency: ws.baseCurrency };
}

/** A stored model's full configuration, Zod-checked; fixed params fall back to the defaults. */
export function modelConfigOf(
  row: Pick<HealthModel, "pillarWeights" | "componentConfig" | "thresholds" | "perTierOverrides">,
): ModelConfig {
  return modelConfigSchema.parse({
    pillarWeights: row.pillarWeights,
    componentConfig: row.componentConfig,
    params: DEFAULT_PARAMS,
    thresholds: row.thresholds,
    perTierOverrides: row.perTierOverrides ?? {},
  });
}

/**
 * The workspace's ACTIVE model. A workspace with none gets version 1 with the default formulas
 * (D-63), labelled as such; the back-test proposal (M3 slice 16) can replace it.
 */
export async function getActiveModel(ctx: TenantContext): Promise<HealthModel> {
  const db = scopedDb(ctx);
  const active = await db.healthModel.findFirst({ where: { status: "ACTIVE" } });
  if (active) return active;
  return db.$tenantTransaction(async (tx) => {
    const again = await tx.healthModel.findFirst({ where: { status: "ACTIVE" } });
    if (again) return again;
    const last = await tx.healthModel.aggregate({ _max: { version: true } });
    return tx.healthModel.create({
      data: {
        workspaceId: ctx.workspaceId,
        version: (last._max.version ?? 0) + 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: DEFAULT_PILLAR_WEIGHTS,
        componentConfig: DEFAULT_COMPONENT_CONFIG,
        thresholds: DEFAULT_THRESHOLDS,
        perTierOverrides: {},
        note: "Default weights — not yet back-tested on your accounts.",
        activatedAt: new Date(),
      },
    });
  });
}

export interface ScoredAccount {
  bundle: AccountBundle;
  score: Aggregate;
  inputsHash: string;
}

/** Scores accounts using only records dated on or before `asOf` (no look-ahead, M3 rule 4). */
export async function scoreAsOf(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
  model: { id: string; config: ModelConfig } = { id: "default", config: DEFAULT_MODEL },
): Promise<Map<string, ScoredAccount>> {
  const bundles = await loadBundles(scopedDb(ctx), await loadContext(ctx), asOf, accountIds);
  return new Map(
    [...bundles].map(([id, bundle]) => [
      id,
      {
        bundle,
        score: scoreBundle(bundle, model.config),
        inputsHash: inputsHash(bundle, model.id),
      },
    ]),
  );
}

/** Scores and stores snapshots for a chunk (the nightly job and "Recompute now" both use this). */
export async function scoreAndStore(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
  modelRow: HealthModel,
  opts: { isBacktest?: boolean; makeCurrent?: boolean } = {},
): Promise<Map<string, WriteResult & { score: Aggregate }>> {
  const scored = await scoreAsOf(ctx, accountIds, asOf, {
    id: modelRow.id,
    config: modelConfigOf(modelRow),
  });
  const db = scopedDb(ctx);
  const out = new Map<string, WriteResult & { score: Aggregate }>();
  for (const [id, s] of scored) {
    const written = await writeSnapshot(
      db,
      ctx.workspaceId,
      {
        accountId: id,
        healthModelId: modelRow.id,
        asOf,
        isBacktest: opts.isBacktest ?? false,
        inputsHash: s.inputsHash,
        score: s.score,
      },
      { makeCurrent: opts.makeCurrent ?? false },
    );
    out.set(id, { ...written, score: s.score });
  }
  return out;
}

export { DEFAULT_MODEL, modelConfigSchema, type ModelConfig };
