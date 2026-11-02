import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import {
  bookWhere,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import {
  describeSource,
  loadContext,
  sourceLookups,
  type SourceRef,
} from "@/modules/health/service";
import { systemClock, todayIn, type Clock } from "@/lib/dates";
import { insertOutsideSignal, outsideInputFor } from "./outside";
import type { SignalListQuery } from "./schemas";
import { parseParams, RULE_BY_KEY, RULES, type RuleKey } from "./rules/catalog";
import { syncSignalRules } from "./rule-rows";
import { scopedDb } from "@/lib/db/scoped";

/**
 * Signals module public surface (ARCHITECTURE §5). Signals are records with a lifecycle; the
 * rules that raise them are deterministic code (no AI in M3).
 */

export { syncSignalRules } from "./rule-rows";

// ─── Lifecycle and human decisions ───────────────────────────────────────────

export { evaluateAndStore, type EvaluateResult } from "./lifecycle";

export class SignalNotFoundError extends Error {
  constructor() {
    super("Signal not found");
    this.name = "SignalNotFoundError";
  }
}

/** The signal, if the caller may act on its account (book scope); otherwise not found. */
async function signalForAction(actor: Actor, signalId: string) {
  requirePermission(actor, "signals:markFalseAlarm");
  const s = await scopedDb(actor).signal.findUnique({ where: { id: signalId } });
  if (!s) throw new SignalNotFoundError();
  await requireEditableAccount(actor, s.accountId);
  return s;
}

/** "Seen it": stays live (and still resolves by itself when the condition clears). */
export async function acknowledgeSignal(actor: Actor, signalId: string) {
  const s = await signalForAction(actor, signalId);
  if (s.status !== "OPEN") return s;
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const updated = await tx.signal.update({
      where: { id: s.id },
      data: {
        status: "ACKNOWLEDGED",
        acknowledgedById: actor.membershipId,
        acknowledgedAt: new Date(),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "signal.acknowledged",
        targetType: "Signal",
        targetId: s.id,
        summary: `Acknowledged: ${s.title}`,
      },
      tx,
    );
    return updated;
  });
}

export const falseAlarmInput = z
  .string()
  .trim()
  .min(3, "Say briefly why this is a false alarm")
  .max(500, "Keep the reason under 500 characters");

/**
 * "Ignore" = mark false alarm (D-53): with a reason, audited; it stays suppressed on re-runs
 * until materially worse than the values recorded now, and then reopens as a new episode.
 */
export async function markFalseAlarm(actor: Actor, signalId: string, rawReason: unknown) {
  const s = await signalForAction(actor, signalId);
  const reason = falseAlarmInput.parse(rawReason);
  if (s.status !== "OPEN" && s.status !== "ACKNOWLEDGED") return s;
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const updated = await tx.signal.update({
      where: { id: s.id },
      data: {
        status: "FALSE_ALARM",
        markedFalseById: actor.membershipId,
        markedFalseAt: new Date(),
        falseAlarmReason: reason,
        falseAlarmValues: s.values as Prisma.InputJsonValue,
      },
    });
    await tx.outcomeRecord.updateMany({ where: { signalId: s.id }, data: { csmAgreed: false } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "signal.false_alarm",
        targetType: "Signal",
        targetId: s.id,
        summary: `Marked false alarm: ${s.title}`,
        before: { status: s.status, severity: s.severity, values: s.values },
        after: { status: "FALSE_ALARM", reason },
      },
      tx,
    );
    return updated;
  });
}

// ─── Reads for the screens (book scope, M3 rule 11) ──────────────────────────

const PAGE = 50;

async function withEvidence<T extends { accountId: string; evidence: Prisma.JsonValue }>(
  actor: Actor,
  rows: T[],
) {
  const refs = rows.flatMap((r) => r.evidence as unknown as SourceRef[]);
  const look = await sourceLookups(scopedDb(actor), refs);
  return rows.map((r) => ({
    ...r,
    evidenceLinks: (r.evidence as unknown as Array<SourceRef & { value?: unknown }>).map((e) => {
      try {
        return describeSource(r.accountId, e, look);
      } catch {
        return { label: e.sourceType, href: null, missing: false };
      }
    }),
  }));
}

/** Every signal on one account (live first), with evidence links and its rule's four fields. */
export async function listAccountSignals(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) return null;
  const db = scopedDb(actor);
  const [signals, rules] = await Promise.all([
    db.signal.findMany({
      where: { accountId },
      orderBy: [{ lastSeenAt: "desc" }, { episode: "desc" }, { id: "asc" }],
      take: 200,
    }),
    db.signalRule.findMany(),
  ]);
  const live = (s: { status: string }) =>
    s.status === "OPEN" || s.status === "ACKNOWLEDGED" ? 0 : 1;
  return {
    account,
    rules: new Map(rules.map((r) => [r.ruleKey, r])),
    signals: await withEvidence(
      actor,
      [...signals].sort((a, b) => live(a) - live(b)),
    ),
  };
}

/** Portfolio list: book-scoped, filtered, most severe first, offset-paged over a total order. */
export async function listSignals(actor: Actor, query: SignalListQuery) {
  const grant = requirePermission(actor, "accounts:view");
  const status = query.status ?? "LIVE";
  const where: Prisma.SignalWhereInput = {
    account: bookWhere(actor, grant.scope),
    ...(status === "LIVE"
      ? { status: { in: ["OPEN", "ACKNOWLEDGED"] } }
      : status === "ALL"
        ? {}
        : { status }),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.category ? { category: query.category } : {}),
  };
  const offset = query.cursor ?? 0;
  const db = scopedDb(actor);
  const [rows, total] = await Promise.all([
    db.signal.findMany({
      where,
      orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }, { id: "asc" }],
      skip: offset,
      take: PAGE,
      include: { account: { select: { name: true } } },
    }),
    db.signal.count({ where }),
  ]);
  return {
    rows: await withEvidence(actor, rows),
    total,
    nextCursor: offset + PAGE < total ? offset + PAGE : null,
    prevCursor: offset > 0 ? Math.max(0, offset - PAGE) : null,
  };
}

// ─── Settings › Signals (thresholds are workspace settings, M3 rule 8, D-65) ──

export class RuleSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSettingsError";
  }
}

export async function listRuleSettings(actor: Actor) {
  requirePermission(actor, "healthModel:propose");
  await syncSignalRules(actor);
  const rows = await scopedDb(actor).signalRule.findMany({
    include: { updatedBy: { select: { user: { select: { name: true, email: true } } } } },
  });
  const order = new Map(RULES.map((r, i) => [r.key, i]));
  return rows
    .sort(
      (a, b) => (order.get(a.ruleKey as RuleKey) ?? 99) - (order.get(b.ruleKey as RuleKey) ?? 99),
    )
    .map((r) => ({ ...r, label: RULE_BY_KEY.get(r.ruleKey as RuleKey)?.label ?? r.ruleKey }));
}

/**
 * Enable/disable a rule or change its thresholds (Admin / CS Leader). Thresholds are validated by
 * the rule's own schema; a change bumps the rule version (signals keep the version that raised
 * them) and is audited with before and after. A dormant rule cannot be switched on (D-61).
 */
export async function updateRuleSettings(
  actor: Actor,
  ruleKey: string,
  input: { enabled?: boolean; params?: unknown },
) {
  requirePermission(actor, "healthModel:propose");
  const meta = RULE_BY_KEY.get(ruleKey as RuleKey);
  if (!meta) throw new RuleSettingsError("Unknown rule.");
  const db = scopedDb(actor);
  const row = await db.signalRule.findFirst({ where: { ruleKey } });
  if (!row) throw new RuleSettingsError("Unknown rule.");
  if (row.dormantReason && input.enabled)
    throw new RuleSettingsError(`This rule cannot run yet: ${row.dormantReason}`);
  const params =
    input.params === undefined
      ? (row.params as Record<string, unknown>)
      : parseParams(meta.key, input.params);
  const paramsChanged = JSON.stringify(params) !== JSON.stringify(row.params);
  const enabled = input.enabled ?? row.enabled;
  if (!paramsChanged && enabled === row.enabled) return row;
  return db.$tenantTransaction(async (tx) => {
    const updated = await tx.signalRule.update({
      where: { id: row.id },
      data: {
        enabled,
        params: params as Prisma.InputJsonValue,
        version: paramsChanged ? row.version + 1 : row.version,
        updatedByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "signal_rule.updated",
        targetType: "SignalRule",
        targetId: row.id,
        summary: `${meta.label}: ${paramsChanged ? `thresholds changed (v${updated.version})` : ""}${paramsChanged && enabled !== row.enabled ? "; " : ""}${enabled !== row.enabled ? (enabled ? "switched on" : "switched off") : ""}`,
        before: { enabled: row.enabled, params: row.params, version: row.version },
        after: { enabled: updated.enabled, params: updated.params, version: updated.version },
      },
      tx,
    );
    return updated;
  });
}

// ─── Outside signals (INTERP-6) ──────────────────────────────────────────────

export {
  outsideDedupeKey,
  outsideInputFor,
  insertOutsideSignal,
  type OutsideInput,
} from "./outside";

/** A person adds public news about an account in their book, with its source link and date. */
export async function createOutsideSignal(actor: Actor, raw: unknown, clock: Clock = systemClock) {
  requirePermission(actor, "accounts:edit");
  const ctx = await loadContext(actor);
  const today = todayIn(ctx.timeZone, clock);
  const input = outsideInputFor(today).parse(raw);
  await requireEditableAccount(actor, input.accountId);
  await syncSignalRules(actor);
  const db = scopedDb(actor);
  const rule = await db.signalRule.findFirstOrThrow({ where: { ruleKey: "outside_event" } });
  return db.$tenantTransaction(async (tx) => {
    const { signal, created } = await insertOutsideSignal(tx, actor.workspaceId, input, {
      origin: "HUMAN",
      createdByMembershipId: actor.membershipId,
      today,
      now: clock(),
      ruleVersion: rule.version,
    });
    if (created)
      await writeAudit(
        {
          workspaceId: actor.workspaceId,
          actorType: "USER",
          actorId: actor.userId,
          action: "signal.outside_added",
          targetType: "Signal",
          targetId: signal.id,
          summary: `Outside signal: ${signal.title}`,
          after: { sourceUrl: input.sourceUrl, eventDate: input.eventDate },
        },
        tx,
      );
    return signal;
  });
}

// ─── Pipeline (ARCHITECTURE §1.2, M3 rule 9) ─────────────────────────────────

export {
  createPipelineProcessors,
  enqueueAccountEvaluation,
  enqueueWorkspaceRun,
  enqueueBacktest,
  backtestRunning,
  type PipelineDeps,
} from "./pipeline";
