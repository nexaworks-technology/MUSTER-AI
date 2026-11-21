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
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { businessClock, todayIn, type Clock } from "@/lib/dates";
import {
  bookWhere,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { calendarDateOf, utcMidnight } from "@/lib/dates";
import { loadBundles, loadPeers, type LoadContext } from "./loader";
import { ownBaselinesSql } from "./baselines-sql";
import { cohortBaseline } from "./engine/baselines";
import { describeSource, sourceLookups, type ResolvedSource } from "./sources";
import type { SourceRef } from "./engine/types";
import { writeSnapshot, type WriteResult } from "./snapshots";
import { formatCalendarDate } from "@/lib/format";

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
/**
 * The snapshot an account's Health tab shows: the latest live snapshot under the active model.
 * Anything written about "the account's health" (the Health Analyst narrative) must be about this
 * one, so every reason it links to is on the page.
 */
export async function displayedSnapshot(ctx: TenantContext, accountId: string) {
  const model = await getActiveModel(ctx);
  return scopedDb(ctx).healthScoreSnapshot.findFirst({
    where: { accountId, healthModelId: model.id, isBacktest: false },
    orderBy: { asOf: "desc" },
    select: { id: true, asOf: true },
  });
}

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

/**
 * Scores and stores snapshots for a chunk (the nightly job, the real-time hook and "Recompute
 * now" all use this). Existing snapshots and pointers are fetched in one go, so an unchanged
 * re-run issues a fixed number of queries whatever the chunk size. The account's current pointer
 * only moves forward in time (a back-dated run never replaces a newer current snapshot).
 */
export async function scoreAndStore(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
  modelRow: HealthModel,
  opts: { isBacktest?: boolean; makeCurrent?: boolean } = {},
): Promise<Map<string, WriteResult & { score: Aggregate; previous: string | null }>> {
  const db = scopedDb(ctx);
  const isBacktest = opts.isBacktest ?? false;
  const [scored, existing, pointers, previous] = await Promise.all([
    scoreAsOf(ctx, accountIds, asOf, { id: modelRow.id, config: modelConfigOf(modelRow) }),
    db.healthScoreSnapshot.findMany({
      where: {
        accountId: { in: accountIds },
        healthModelId: modelRow.id,
        asOf: utcMidnight(asOf),
        isBacktest,
      },
      select: { id: true, accountId: true, inputsHash: true },
    }),
    opts.makeCurrent
      ? db.account.findMany({
          where: { id: { in: accountIds } },
          select: {
            id: true,
            currentHealthSnapshotId: true,
            currentHealth: { select: { asOf: true } },
          },
        })
      : Promise.resolve([]),
    // The band before this date (same model), to report band changes.
    db.healthScoreSnapshot.findMany({
      where: {
        accountId: { in: accountIds },
        healthModelId: modelRow.id,
        asOf: { lt: utcMidnight(asOf) },
        isBacktest,
      },
      orderBy: [{ accountId: "asc" }, { asOf: "desc" }],
      distinct: ["accountId"],
      select: { accountId: true, riskLevel: true },
    }),
  ]);
  const have = new Map(existing.map((e) => [e.accountId, e]));
  const pointer = new Map(pointers.map((p) => [p.id, p]));
  const before = new Map(previous.map((p) => [p.accountId, p.riskLevel]));
  const out = new Map<string, WriteResult & { score: Aggregate; previous: string | null }>();
  for (const [id, s] of scored) {
    const p = pointer.get(id);
    const makeCurrent =
      (opts.makeCurrent ?? false) &&
      (!p?.currentHealth || calendarDateOf(p.currentHealth.asOf) <= asOf);
    const prev = have.get(id);
    if (
      prev &&
      prev.inputsHash === s.inputsHash &&
      (!makeCurrent || p?.currentHealthSnapshotId === prev.id)
    ) {
      out.set(id, {
        id: prev.id,
        outcome: "UNCHANGED",
        score: s.score,
        previous: before.get(id) ?? null,
      });
      continue;
    }
    const written = await writeSnapshot(
      db,
      ctx.workspaceId,
      {
        accountId: id,
        healthModelId: modelRow.id,
        asOf,
        isBacktest,
        inputsHash: s.inputsHash,
        score: s.score,
      },
      { makeCurrent },
    );
    out.set(id, { ...written, score: s.score, previous: before.get(id) ?? null });
  }
  return out;
}

/**
 * Stores the chunk's own normal and cohort for the date (ARCHITECTURE §4.2): computed in SQL,
 * create-only for a given date, so a re-run leaves the rows exactly as they were.
 */
export async function storeUsageBaselines(
  ctx: TenantContext,
  asOf: CalendarDate,
  accountIds: string[],
) {
  const db = scopedDb(ctx);
  const load = await loadContext(ctx);
  const [own, peers] = await Promise.all([
    ownBaselinesSql(db, ctx.workspaceId, asOf, accountIds),
    loadPeers(db, load, asOf),
  ]);
  const byId = new Map(peers.list.map((p) => [p.id, p]));
  await db.usageBaseline.createMany({
    skipDuplicates: true,
    data: accountIds.flatMap((id) => {
      const me = byId.get(id);
      const o = own.get(id);
      if (!me || !o) return [];
      const cohort = cohortBaseline(me, peers.list, DEFAULT_PARAMS.cohortMinPeers);
      return [
        {
          workspaceId: ctx.workspaceId,
          accountId: id,
          metric: "active_users_typical_weekday",
          windowEnd: utcMidnight(asOf),
          accountMedian: o.median,
          accountP25: o.p25,
          historyDays: o.historyDays,
          cohortKey: cohort.key,
          cohortMedian: cohort.medianRate,
          cohortSize: cohort.size,
        },
      ];
    }),
  });
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

/** Latest Pulse per account; `valid` is judged at `now` (the clock is injectable, M3 rule 7). */
async function latestPulses(db: ReturnType<typeof scopedDb>, accountIds: string[], now: Date) {
  const rows = await db.csmPulse.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    distinct: ["accountId"],
    include: { membership: { select: { user: { select: { name: true, email: true } } } } },
  });
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
export async function getAccountHealth(
  actor: Actor,
  accountId: string,
  clock: Clock = businessClock,
) {
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
    latestPulses(db, [accountId], clock()),
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
export async function healthForAccounts(
  ctx: TenantContext,
  accountIds: string[],
  clock: Clock = businessClock,
) {
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
    latestPulses(db, accountIds, clock()),
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

// ─── CSM Pulse (spec §6C5, INTERP-2, M3 rule 10) ─────────────────────────────

export const pulseInput = z.object({
  value: z.enum(["FINE", "WORRIED"]),
  comment: z
    .string()
    .trim()
    .max(500, "Keep the comment under 500 characters")
    .optional()
    .transform((v) => v || undefined),
});

/**
 * A CSM's "Actually fine" / "Worried". Stored with who and when (history is kept), valid for 30
 * days, audited, and the account is re-scored at once through the same scoring path as the
 * nightly run. The score is never set to match the Pulse: the Pulse is one Relationship input.
 */
export async function setPulse(
  actor: Actor,
  accountId: string,
  raw: unknown,
  clock: Clock = businessClock,
) {
  requirePermission(actor, "pulse:set");
  await requireEditableAccount(actor, accountId);
  const input = pulseInput.parse(raw);
  const now = clock();
  const pulse = await scopedDb(actor).$tenantTransaction(async (tx) => {
    const p = await tx.csmPulse.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId,
        membershipId: actor.membershipId,
        value: input.value,
        comment: input.comment ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEFAULT_PARAMS.pulseValidDays * 86_400_000),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "health.pulse_set",
        targetType: "Account",
        targetId: accountId,
        summary: `CSM Pulse: ${input.value === "FINE" ? "Actually fine" : "Worried"}`,
        after: { value: input.value, comment: input.comment ?? null, pulseId: p.id },
      },
      tx,
    );
    return p;
  });
  await recomputeAccounts(actor, [accountId], clock);
  return pulse;
}

/** Re-scores accounts for today (workspace time zone) with the active model. */
export async function recomputeAccounts(
  ctx: TenantContext,
  accountIds: string[],
  clock: Clock = businessClock,
) {
  const load = await loadContext(ctx);
  return scoreAndStore(ctx, accountIds, todayIn(load.timeZone, clock), await getActiveModel(ctx), {
    makeCurrent: true,
  });
}

export { DEFAULT_MODEL, modelConfigSchema, type ModelConfig };

// The point-in-time bundle and helpers the signal rules share with the health engine (one
// definition of "typical weekday", "current champion", "status as of", …).
export type { AccountBundle, SourceRef } from "./engine/types";
export { chooseCohort, ownBaseline, percentile, type CohortAttrs } from "./engine/baselines";
export { currentUsage, typicalWeekday, inRange } from "./engine/windows";
export {
  rolesKnown,
  statusAsOf,
  validOn,
  currentHolder,
  lastEnded,
} from "./engine/components/people";
export { day as formatDay } from "./engine/format";
export { championState, type ChampionState } from "./champion";
export { loadBundles } from "./loader";
export { describeSource, sourceLookups, type ResolvedSource } from "./sources";

// ─── Health screen (spec §5 Health): bands, movers, disagreements ────────────

const BANDS = ["AT_RISK", "WATCH", "HEALTHY", "INSUFFICIENT_DATA"] as const;
export type Band = (typeof BANDS)[number];

export interface Mover {
  accountId: string;
  name: string;
  from: { overall: number | null; riskLevel: Band };
  to: { overall: number | null; riskLevel: Band };
  /** The reason whose impact changed most between the two snapshots. */
  topReason: string | null;
}

/**
 * The portfolio as the viewer may see it (book scope): accounts per band (ARR per band only with
 * revenue access, M3 rule 11), what moved since yesterday and in the last 7 days (band changed or
 * ≥ 10 points) with the reason that moved most, and where score and CSM disagree.
 */
export async function healthOverview(actor: Actor, clock: Clock = businessClock) {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const model = await getActiveModel(actor);
  const accounts = await db.account.findMany({
    where: {
      AND: [bookWhere(actor, grant.scope), { archivedAt: null, lifecycleStage: { not: "LOST" } }],
    },
    select: {
      id: true,
      name: true,
      arrMinor: true,
      arrCurrency: true,
      ownerMembershipId: true,
      currentHealth: {
        select: {
          id: true,
          asOf: true,
          overall: true,
          riskLevel: true,
          healthModelId: true,
          pulseDisagreement: true,
          pulseValue: true,
          riskLevelExcludingPulse: true,
          overallExcludingPulse: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });
  const current = accounts.filter((a) => a.currentHealth?.healthModelId === model.id);
  const latest = current.reduce<Date | null>(
    (m, a) => (m === null || a.currentHealth!.asOf > m ? a.currentHealth!.asOf : m),
    null,
  );
  const bands = Object.fromEntries(BANDS.map((b) => [b, { count: 0, arrMinor: 0n }])) as Record<
    Band,
    { count: number; arrMinor: bigint }
  >;
  let unscored = 0;
  for (const a of accounts) {
    const h = a.currentHealth?.healthModelId === model.id ? a.currentHealth : null;
    if (!h) {
      unscored++;
      continue;
    }
    bands[h.riskLevel].count++;
    bands[h.riskLevel].arrMinor += a.arrMinor ?? 0n;
  }

  const movers = { today: [] as Mover[], week: [] as Mover[] };
  if (latest) {
    const day = (n: number) => new Date(latest.getTime() - n * 86_400_000);
    const past = await db.healthScoreSnapshot.findMany({
      where: {
        accountId: { in: current.map((a) => a.id) },
        healthModelId: model.id,
        isBacktest: false,
        asOf: { in: [day(1), day(7)] },
      },
      select: { id: true, accountId: true, asOf: true, overall: true, riskLevel: true },
    });
    const pick = (n: number) =>
      new Map(
        past.filter((p) => p.asOf.getTime() === day(n).getTime()).map((p) => [p.accountId, p]),
      );
    const moved = (n: number) =>
      current.flatMap((a) => {
        const was = pick(n).get(a.id);
        const now = a.currentHealth!;
        if (!was) return [];
        const delta = Math.abs((num(now.overall) ?? 0) - (num(was.overall) ?? 0));
        if (was.riskLevel === now.riskLevel && delta < 10) return [];
        return [{ a, was, now }];
      });
    const today = moved(1);
    const week = moved(7);
    const ids = [...today, ...week].flatMap((m) => [m.was.id, m.now.id]);
    const reasons = ids.length
      ? await db.healthReason.findMany({
          where: { snapshotId: { in: ids }, kind: "EVIDENCE" },
          select: { snapshotId: true, component: true, impact: true, message: true },
        })
      : [];
    const top = (wasId: string, nowId: string) => {
      const before = new Map(
        reasons
          .filter((r) => r.snapshotId === wasId)
          .map((r) => [r.component, r.impact.toNumber()]),
      );
      return (
        reasons
          .filter((r) => r.snapshotId === nowId)
          .map((r) => ({
            message: r.message,
            change: Math.abs(r.impact.toNumber() - (before.get(r.component) ?? 0)),
          }))
          .sort((x, y) => y.change - x.change)[0]?.message ?? null
      );
    };
    const toMover = (m: (typeof today)[number]): Mover => ({
      accountId: m.a.id,
      name: m.a.name,
      from: { overall: num(m.was.overall), riskLevel: m.was.riskLevel },
      to: { overall: num(m.now.overall), riskLevel: m.now.riskLevel },
      topReason: top(m.was.id, m.now.id),
    });
    movers.today = today.map(toMover);
    movers.week = week.map(toMover);
  }

  const pulses = await latestPulses(
    db,
    current.filter((a) => a.currentHealth!.pulseDisagreement).map((a) => a.id),
    clock(),
  );
  const disagreements = current
    .filter((a) => a.currentHealth!.pulseDisagreement)
    .map((a) => ({
      accountId: a.id,
      name: a.name,
      overall: num(a.currentHealth!.overall),
      riskLevel: a.currentHealth!.riskLevel,
      overallExcludingPulse: num(a.currentHealth!.overallExcludingPulse),
      riskLevelExcludingPulse: a.currentHealth!.riskLevelExcludingPulse,
      pulse: pulses.get(a.id) ?? null,
    }));

  return {
    model: { version: model.version, proposedBy: model.proposedBy },
    asOf: latest ? calendarDateOf(latest) : null,
    bands: Object.fromEntries(
      BANDS.map((b) => [
        b,
        // Money only with revenue access (M2 "Restricted" pattern).
        { count: bands[b].count, arrMinor: actor.canViewRevenue ? bands[b].arrMinor : null },
      ]),
    ) as Record<Band, { count: number; arrMinor: bigint | null }>,
    unscored,
    movers,
    disagreements,
  };
}

/** Rows returned by `listUnscoredAccounts`; the Health page says so when it is reached. */
export const UNSCORED_LIST_LIMIT = 200;

export interface UnscoredAccount {
  accountId: string;
  name: string;
  /** LOST: not scored by design. AWAITING_FIRST_SCORE: active, no score for the active model yet. */
  kind: "LOST" | "AWAITING_FIRST_SCORE";
  /** The reason, in plain words, shown beside the account. */
  reason: string;
  /** Calendar date the account was marked churned, when it was recorded (LOST only). */
  churnedAt: string | null;
}

/**
 * Every account in the member's book that has no health score, with why (FIX-2026-11-11). Lost
 * accounts are never scored (the nightly pipeline, the Health overview and every agent skip
 * them), so they appear in no band; this list is where they are shown instead of being silently
 * absent. Active accounts not yet scored by the active model are the Health page's `unscored`.
 * Missing data never lowers a score (rule 4): nothing here is a score.
 */
export async function listUnscoredAccounts(actor: Actor): Promise<UnscoredAccount[]> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const model = await getActiveModel(actor);
  const rows = await db.account.findMany({
    where: {
      AND: [
        bookWhere(actor, grant.scope),
        { archivedAt: null },
        {
          OR: [
            { lifecycleStage: "LOST" },
            { currentHealthSnapshotId: null },
            { currentHealth: { is: { healthModelId: { not: model.id } } } },
          ],
        },
      ],
    },
    select: { id: true, name: true, lifecycleStage: true, churnedAt: true },
    orderBy: { name: "asc" },
    take: UNSCORED_LIST_LIMIT,
  });
  const out = rows.map((a): UnscoredAccount =>
    a.lifecycleStage === "LOST"
      ? {
          accountId: a.id,
          name: a.name,
          kind: "LOST",
          reason:
            "Lost account. Health is only calculated for active customers, so it is not scored.",
          churnedAt: a.churnedAt ? calendarDateOf(a.churnedAt) : null,
        }
      : {
          accountId: a.id,
          name: a.name,
          kind: "AWAITING_FIRST_SCORE",
          reason:
            "Active account that has not been scored by the current health model yet. It is scored in the next nightly run, or when someone recomputes.",
          churnedAt: null,
        },
  );
  // Active accounts waiting for a score first: those are the ones someone can act on.
  return [
    ...out.filter((u) => u.kind === "AWAITING_FIRST_SCORE"),
    ...out.filter((u) => u.kind === "LOST"),
  ];
}

// ─── Portfolio health for Ask AI (FIX-2026-11-11-ASK2) ───────────────────────────────────────────

export interface PortfolioHealthReason {
  id: string;
  message: string;
  pillar: string;
  impact: number;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface PortfolioHealthAccount {
  accountId: string;
  name: string;
  band: Band;
  overall: number | null;
  snapshotId: string;
  asOf: string;
  /** Only for a member with revenue access; null otherwise (Restricted). */
  arrMinor: bigint | null;
  arrCurrency: string | null;
  reasons: PortfolioHealthReason[];
}

export interface PortfolioHealth {
  asOf: string | null;
  counts: Record<Band, number>;
  /** Accounts in the requested bands (Watch and At Risk by default), however many are listed. */
  totalInBands: number;
  accounts: PortfolioHealthAccount[];
}

const BAD_BANDS: Band[] = ["AT_RISK", "WATCH"];
const BAND_RANK: Record<string, number> = { AT_RISK: 0, WATCH: 1 };

/**
 * "Which accounts are at risk and why", as one deterministic read: the band counts and the
 * accounts in the bad bands, worst first, each with its most negative evidence reasons and the ids
 * of those reasons. The same snapshot the Health page shows (latest live one under the active
 * model), limited to the member's book, with ARR only for members who may see money. Nothing here
 * is a model output.
 */
export async function portfolioHealth(
  actor: Actor,
  opts: { bands?: Band[]; limit?: number; reasonsPerAccount?: number } = {},
): Promise<PortfolioHealth> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const bands = opts.bands?.length ? opts.bands : BAD_BANDS;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const perAccount = Math.max(1, Math.min(opts.reasonsPerAccount ?? 3, 5));
  // In order: both create the default model on first use, and two concurrent first calls race.
  const model = await getActiveModel(actor);
  const overview = await healthOverview(actor);
  const counts = Object.fromEntries(BANDS.map((b) => [b, overview.bands[b].count])) as Record<
    Band,
    number
  >;

  const inBands = await db.account.findMany({
    where: {
      AND: [
        bookWhere(actor, grant.scope),
        { archivedAt: null, lifecycleStage: { not: "LOST" } },
        { currentHealth: { is: { healthModelId: model.id, riskLevel: { in: bands } } } },
      ],
    },
    select: {
      id: true,
      name: true,
      arrMinor: true,
      arrCurrency: true,
      currentHealth: { select: { id: true, asOf: true, overall: true, riskLevel: true } },
    },
  });
  const ranked = inBands
    .filter((a) => a.currentHealth)
    .sort(
      (a, b) =>
        (BAND_RANK[a.currentHealth!.riskLevel] ?? 9) -
          (BAND_RANK[b.currentHealth!.riskLevel] ?? 9) ||
        (num(a.currentHealth!.overall) ?? 0) - (num(b.currentHealth!.overall) ?? 0) ||
        a.name.localeCompare(b.name),
    );
  const top = ranked.slice(0, limit);
  const reasons = top.length
    ? await db.healthReason.findMany({
        where: {
          snapshotId: { in: top.map((a) => a.currentHealth!.id) },
          kind: "EVIDENCE",
          direction: "DOWN",
        },
        orderBy: [{ impact: "asc" }, { sortOrder: "asc" }],
        select: {
          id: true,
          snapshotId: true,
          message: true,
          pillar: true,
          impact: true,
          periodStart: true,
          periodEnd: true,
        },
      })
    : [];
  const bySnapshot = new Map<string, PortfolioHealthReason[]>();
  for (const r of reasons) {
    const list = bySnapshot.get(r.snapshotId) ?? [];
    if (list.length < perAccount)
      list.push({
        id: r.id,
        message: r.message,
        pillar: r.pillar,
        impact: num(r.impact) ?? 0,
        periodStart: r.periodStart ? calendarDateOf(r.periodStart) : null,
        periodEnd: r.periodEnd ? calendarDateOf(r.periodEnd) : null,
      });
    bySnapshot.set(r.snapshotId, list);
  }
  return {
    asOf: overview.asOf,
    counts,
    totalInBands: ranked.length,
    accounts: top.map((a) => ({
      accountId: a.id,
      name: a.name,
      band: a.currentHealth!.riskLevel as Band,
      overall: num(a.currentHealth!.overall),
      snapshotId: a.currentHealth!.id,
      asOf: calendarDateOf(a.currentHealth!.asOf),
      arrMinor: actor.canViewRevenue ? a.arrMinor : null,
      arrCurrency: actor.canViewRevenue ? a.arrCurrency : null,
      reasons: bySnapshot.get(a.currentHealth!.id) ?? [],
    })),
  };
}

// ─── Back-test, proposal and versions (implemented in backtest-service.ts) ───
export {
  activateModel,
  labelledOutcomes,
  listModels,
  ModelActivationError,
  OUTCOME_WINDOW_MONTHS,
  PILLAR_MEANING,
  previewModelEdit,
  runBacktestProposal,
  saveModelEdit,
  type StoredBacktest,
} from "./backtest-service";
export { sentence as backtestSentence } from "./engine/backtest";
export type { Outcome as LabelledOutcome } from "./engine/backtest";

/** D-158: the one filter every live-health reader must use (excludes back-test rows). */
export { liveSnapshotWhere } from "./live";

/**
 * The Health tab with no snapshot, in words. A Lost account is never scored, so it must not be
 * told it will be "tonight" (DEMO-WALKTHROUGH FAIL 17); the Health page already says "Not scored".
 */
export function noHealthText(account: {
  lifecycleStage: string;
  churnedAt: Date | null;
}): string {
  if (account.lifecycleStage === "LOST")
    return `Lost, not scored${account.churnedAt ? ` (lost ${formatCalendarDate(account.churnedAt)})` : ""}. Health is only calculated for active customers.`;
  return "Health has not been calculated for this account yet. It is calculated every night and whenever someone presses Recompute.";
}
