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
import { getAccount, type Actor } from "@/modules/accounts/service";
import { calendarDateOf } from "@/lib/dates";
import { loadBundles, type LoadContext } from "./loader";
import { describeSource, sourceLookups, type ResolvedSource } from "./sources";
import type { SourceRef } from "./engine/types";
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

// ─── Reads for the screens (RBAC: the account must be in the viewer's book) ───

const PILLAR_COLUMNS = [
  "adoption",
  "engagement",
  "support",
  "relationship",
  "commercial",
  "sentiment",
] as const;
const num = (d: { toNumber(): number } | null) => (d === null ? null : d.toNumber());

export interface PulseView {
  id: string;
  value: "FINE" | "WORRIED";
  comment: string | null;
  author: string;
  createdAt: Date;
  expiresAt: Date;
  valid: boolean;
}

async function latestPulses(db: ReturnType<typeof scopedDb>, accountIds: string[]) {
  const rows = await db.csmPulse.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    distinct: ["accountId"],
    include: { membership: { select: { user: { select: { name: true, email: true } } } } },
  });
  const now = new Date();
  return new Map(
    rows.map((p): [string, PulseView] => [
      p.accountId,
      {
        id: p.id,
        value: p.value,
        comment: p.comment,
        author: p.membership.user.name ?? p.membership.user.email,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        valid: p.expiresAt > now,
      },
    ]),
  );
}

/** Account 360 Health tab: the latest live snapshot under the active model, with resolved proof. */
export async function getAccountHealth(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) return null;
  const db = scopedDb(actor);
  const model = await getActiveModel(actor);
  const where = { accountId, healthModelId: model.id, isBacktest: false };
  const [snapshot, history, pulses] = await Promise.all([
    db.healthScoreSnapshot.findFirst({
      where,
      orderBy: { asOf: "desc" },
      include: { reasons: { orderBy: { sortOrder: "asc" } } },
    }),
    db.healthScoreSnapshot.findMany({
      where,
      orderBy: { asOf: "desc" },
      take: 120,
      select: { asOf: true, overall: true, riskLevel: true },
    }),
    latestPulses(db, [accountId]),
  ]);
  const refs = (snapshot?.reasons ?? []).flatMap((r) => r.sources as unknown as SourceRef[]);
  const look = await sourceLookups(db, refs);
  return {
    account,
    model: { id: model.id, version: model.version, proposedBy: model.proposedBy, note: model.note },
    pulse: pulses.get(accountId) ?? null,
    snapshot: snapshot && {
      id: snapshot.id,
      asOf: calendarDateOf(snapshot.asOf),
      overall: num(snapshot.overall),
      overallExcludingPulse: num(snapshot.overallExcludingPulse),
      riskLevel: snapshot.riskLevel,
      riskLevelExcludingPulse: snapshot.riskLevelExcludingPulse,
      pulseDisagreement: snapshot.pulseDisagreement,
      riskReasonId: snapshot.riskReasonId,
      pillars: Object.fromEntries(
        PILLAR_COLUMNS.map((c) => [c.toUpperCase(), num(snapshot[c])]),
      ) as Record<string, number | null>,
      effectiveWeights: snapshot.effectiveWeights as Record<string, number | null>,
      reasons: snapshot.reasons.map((r) => ({
        id: r.id,
        pillar: r.pillar,
        component: r.component,
        input: r.input,
        kind: r.kind,
        direction: r.direction,
        impact: r.impact.toNumber(),
        score: num(r.score),
        message: r.message,
        value: num(r.value),
        baseline: num(r.baseline),
        cohortValue: num(r.cohortValue),
        cohortKey: r.cohortKey,
        cohortSize: r.cohortSize,
        periodStart: r.periodStart ? calendarDateOf(r.periodStart) : null,
        periodEnd: r.periodEnd ? calendarDateOf(r.periodEnd) : null,
        sources: (r.sources as unknown as SourceRef[]).map((s): ResolvedSource =>
          describeSource(accountId, s, look),
        ),
      })),
    },
    history: history.reverse().map((h) => ({
      asOf: calendarDateOf(h.asOf),
      overall: num(h.overall),
      riskLevel: h.riskLevel,
    })),
  };
}
export type AccountHealth = NonNullable<Awaited<ReturnType<typeof getAccountHealth>>>;

/** Health + Pulse for a page of accounts the caller already loaded through the book scope. */
export async function healthForAccounts(ctx: TenantContext, accountIds: string[]) {
  const db = scopedDb(ctx);
  const [accounts, pulses] = await Promise.all([
    db.account.findMany({
      where: { id: { in: accountIds } },
      select: {
        id: true,
        currentHealth: {
          select: { overall: true, riskLevel: true, pulseDisagreement: true, asOf: true },
        },
      },
    }),
    latestPulses(db, accountIds),
  ]);
  return new Map(
    accounts.map((a) => [
      a.id,
      {
        overall: a.currentHealth ? num(a.currentHealth.overall) : null,
        riskLevel: a.currentHealth?.riskLevel ?? null,
        pulseDisagreement: a.currentHealth?.pulseDisagreement ?? false,
        pulse: pulses.get(a.id) ?? null,
      },
    ]),
  );
}

export { DEFAULT_MODEL, modelConfigSchema, type ModelConfig };
