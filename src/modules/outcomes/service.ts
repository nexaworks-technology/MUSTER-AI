import { Prisma, type OutcomeRecord } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { businessClock, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { revenueStatusOf, type RevenueEventFact, type RevenueStatus } from "./checkpoints";

/**
 * The outcome ledger's write side for M4 (spec §6L3, ARCHITECTURE §6.5): did anyone act on a
 * flag, and what happened by day 7. Deterministic rules over records, each with evidence. 30/90-day
 * checkpoints and renewal outcomes come in M7/M11.
 */
export interface ActionRef {
  type: "Approval" | "OutboundMessage" | "Task" | "PlayStep";
  id: string;
}

/**
 * A linked action happened (approval approved, message sent, task done): the flag's outcome
 * record becomes ACTED. IGNORED records are re-evaluated (a late action still counts). Idempotent:
 * the same ref is recorded once.
 */
export async function markActed(
  ctx: TenantContext,
  link: { signalId: string },
  ref: ActionRef,
  clock: Clock = businessClock,
): Promise<OutcomeRecord | null> {
  const db = scopedDb(ctx);
  const record = await db.outcomeRecord.findUnique({
    where: { workspaceId_signalId: { workspaceId: ctx.workspaceId, signalId: link.signalId } },
  });
  if (!record) return null;
  const refs = Array.isArray(record.actionRefs)
    ? (record.actionRefs as unknown as ActionRef[])
    : [];
  if (refs.some((r) => r.type === ref.type && r.id === ref.id) && record.actionTaken === "ACTED")
    return record;
  const now = clock();
  return db.$tenantTransaction(async (tx) => {
    const updated = await tx.outcomeRecord.update({
      where: { id: record.id },
      data: {
        actionTaken: "ACTED",
        firstActionAt: record.firstActionAt ?? now,
        actionRefs: [...refs, ref] as unknown as Prisma.InputJsonValue,
      },
    });
    if (record.actionTaken !== "ACTED")
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "outcome.acted",
          targetType: "OutcomeRecord",
          targetId: record.id,
          summary: `Flag acted on (${ref.type})`,
          after: { ref },
        },
        tx,
      );
    return updated;
  });
}

const DAY = 86_400_000;
const BETTER: Record<string, number> = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 };

export interface Checkpoint {
  status: "REPLIED" | "RECOVERED" | "NO_CHANGE";
  evaluatedAt: string;
  actionTaken: "ACTED" | "IGNORED";
  evidence: Array<{ sourceType: string; sourceId: string }>;
  detail: string;
}

/**
 * The 7-day checkpoint (D-79). For each RISK/OPPORTUNITY record flagged ≥ 7 days ago without a
 * d7 result: no action by day 7 → IGNORED; then REPLIED if the account wrote in after the first
 * action and by day 7 (evidence: the message); else RECOVERED if the health band at day 7 is better
 * than at the flag and every snapshot since the first better one stayed better (evidence: the
 * snapshots); else NO_CHANGE. Idempotent: an evaluated record is not evaluated again.
 */
export async function evaluateSevenDayCheckpoints(
  ctx: TenantContext,
  clock: Clock = businessClock,
) {
  const db = scopedDb(ctx);
  const now = clock();
  const due = await db.outcomeRecord.findMany({
    where: {
      d7Outcome: { equals: Prisma.DbNull },
      flaggedAt: { lte: new Date(+now - 7 * DAY) },
    },
  });
  const counts: Record<string, number> = {};
  for (const r of due) {
    const day7 = new Date(+r.flaggedAt + 7 * DAY);
    const actionTaken = r.actionTaken === "ACTED" ? "ACTED" : "IGNORED";
    let cp: Checkpoint;
    const reply =
      r.firstActionAt &&
      (await db.message.findFirst({
        where: {
          accountId: r.accountId,
          direction: "INBOUND",
          sentAt: { gt: r.firstActionAt, lte: day7 },
        },
        orderBy: { sentAt: "asc" },
        select: { id: true },
      }));
    if (reply) {
      cp = {
        status: "REPLIED",
        evaluatedAt: now.toISOString(),
        actionTaken,
        evidence: [{ sourceType: "Message", sourceId: reply.id }],
        detail: "The account wrote back after the first action.",
      };
    } else {
      const snaps = await db.healthScoreSnapshot.findMany({
        where: { accountId: r.accountId, isBacktest: false, asOf: { lte: day7 } },
        orderBy: { asOf: "asc" },
        select: { id: true, asOf: true, riskLevel: true },
      });
      const atFlag = [...snaps].reverse().find((s) => s.asOf <= r.flaggedAt);
      const after = snaps.filter((s) => s.asOf > r.flaggedAt);
      const firstBetter = atFlag
        ? after.findIndex((s) => (BETTER[s.riskLevel] ?? -1) > (BETTER[atFlag.riskLevel] ?? 99))
        : -1;
      const held =
        firstBetter >= 0 &&
        after
          .slice(firstBetter)
          .every((s) => (BETTER[s.riskLevel] ?? -1) > (BETTER[atFlag!.riskLevel] ?? 99));
      cp = held
        ? {
            status: "RECOVERED",
            evaluatedAt: now.toISOString(),
            actionTaken,
            evidence: [atFlag!, ...after.slice(firstBetter)].map((s) => ({
              sourceType: "HealthScoreSnapshot",
              sourceId: s.id,
            })),
            detail: `Health improved from ${atFlag!.riskLevel} and held through day 7.`,
          }
        : {
            status: "NO_CHANGE",
            evaluatedAt: now.toISOString(),
            actionTaken,
            evidence: [],
            detail: "No reply and no lasting health improvement by day 7.",
          };
    }
    await db.outcomeRecord.update({
      where: { id: r.id },
      data: {
        d7Outcome: cp as unknown as Prisma.InputJsonValue,
        ...(r.actionTaken === "PENDING" ? { actionTaken: "IGNORED" } : {}),
      },
    });
    counts[cp.status] = (counts[cp.status] ?? 0) + 1;
  }
  return { evaluated: due.length, counts };
}

// ─── M7 B5: revenue statuses ────────────────────────────────────────────────────────────────

export type { RevenueStatus };
// M11: the 30/90-day checkpoints (pure rules + their write side), reached through this module's service.
export { classifyAlarm, decideCheckpoint, type LongCheckpoint } from "./checkpoints";
export { evaluateLongCheckpoints } from "./checkpoints.service";

/** What happened to revenue after a flag, with the records behind it (Q-15: attributed, not causal). */
export interface RevenueCheckpoint {
  status: RevenueStatus;
  evaluatedAt: string;
  occurredOn: string;
  attributed: true;
  note: string;
  detail: string;
  evidence: Array<{ sourceType: "RenewalOutcome" | "RevenueEvent"; sourceId: string }>;
  /** Currency of the expanded value (the flag may have had no ARR to name one). */
  valueCurrency: string | null;
}

/** Revenue records count for 90 days after the flag; the 30/90-day completion itself is M11. */
export const REVENUE_WINDOW_DAYS = 90;
/** A record stays under evaluation for a week after its window closes, then it is final. */
const GRACE_DAYS = 7;
const ATTRIBUTION_NOTE =
  "Attributed to the flag from records within 90 days; not proven to be caused by it (Q-15).";
const day = (d: Date) => d.toISOString().slice(0, 10);
/** jsonb does not keep key order: compare with keys sorted. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/**
 * The revenue statuses (ARCHITECTURE §6.5, Q-15), deterministic from Session A's RenewalOutcome
 * snapshots and the revenue events dated from the flag to 90 days after it:
 *
 * - RISK flag: CHURNED (a churned renewal outcome or a churn event) outranks CONTRACTED (a
 *   contraction event), which outranks RENEWED (a renewed outcome).
 * - OPPORTUNITY flag: CHURNED, then CONTRACTED, then EXPANDED (expansion events).
 *
 * `valueSavedMinor` is the ARR at the flag, only for a RISK flag that was ACTED on and ended
 * RENEWED; `valueExpandedMinor` is the sum of the positive expansion deltas for an OPPORTUNITY flag
 * that ended EXPANDED. Neither is ever 0 for "unknown". A record is re-evaluated while its window is
 * open (a correction replaces an earlier outcome) and for a week after; a record whose window holds
 * nothing keeps no status. Idempotent: an unchanged result writes nothing.
 */
export async function evaluateRevenueCheckpoints(ctx: TenantContext, clock: Clock = businessClock) {
  const db = scopedDb(ctx);
  const now = clock();
  const records = await db.outcomeRecord.findMany({
    where: {
      flaggedAt: {
        lte: now,
        gt: new Date(+now - (REVENUE_WINDOW_DAYS + GRACE_DAYS) * DAY),
      },
    },
  });
  if (records.length === 0) return { evaluated: 0, changed: 0 };
  const accountIds = [...new Set(records.map((r) => r.accountId))];
  const earliest = new Date(Math.min(...records.map((r) => +r.flaggedAt)));
  const [outcomes, events] = await Promise.all([
    db.renewalOutcome.findMany({
      where: { accountId: { in: accountIds }, occurredOn: { gte: new Date(day(earliest)) } },
      select: { id: true, accountId: true, result: true, occurredOn: true, supersedesId: true },
    }),
    db.revenueEvent.findMany({
      where: {
        accountId: { in: accountIds },
        type: { in: ["EXPANSION", "CONTRACTION", "CHURN"] },
        effectiveDate: { gte: new Date(day(earliest)) },
      },
      select: {
        id: true,
        accountId: true,
        type: true,
        deltaArrMinor: true,
        currency: true,
        effectiveDate: true,
      },
    }),
  ]);
  // The effective outcome of a renewal is the one no other row corrects (across all rows loaded).
  const superseded = new Set(outcomes.flatMap((o) => (o.supersedesId ? [o.supersedesId] : [])));
  const effective = outcomes.filter((o) => !superseded.has(o.id));
  let changed = 0;
  for (const r of records) {
    const from = day(r.flaggedAt);
    const to = day(new Date(Math.min(+now, +r.flaggedAt + REVENUE_WINDOW_DAYS * DAY)));
    const inWindow = (d: Date) => day(d) >= from && day(d) <= to;
    const mine = {
      outcomes: effective.filter((o) => o.accountId === r.accountId && inWindow(o.occurredOn)),
      events: events.filter((e) => e.accountId === r.accountId && inWindow(e.effectiveDate)),
    };
    // M11: the status rule is shared with the 30/90-day checkpoints (one definition).
    const decided = revenueStatusOf(
      r.flagType,
      mine.outcomes.map((o) => ({ ...o, on: day(o.occurredOn) })),
      mine.events.map((e) => ({
        ...e,
        type: e.type as RevenueEventFact["type"],
        on: day(e.effectiveDate),
      })),
    );
    const status: RevenueStatus | null = decided?.status ?? null;
    const evidence = (decided?.evidence ?? []) as RevenueCheckpoint["evidence"];
    const dates = decided?.dates ?? [];
    const expanded = mine.events.filter((e) => e.type === "EXPANSION" && e.deltaArrMinor > 0n);
    const expandedCurrency = expanded[0]?.currency ?? null;
    const valueSaved =
      status === "RENEWED" && r.actionTaken === "ACTED" ? (r.arrAtFlagMinor ?? null) : null;
    const valueExpanded =
      status === "EXPANDED"
        ? expanded
            .filter((e) => e.currency === expandedCurrency)
            .reduce((s, e) => s + e.deltaArrMinor, 0n)
        : null;
    const next: RevenueCheckpoint | null = status
      ? {
          status,
          evaluatedAt: now.toISOString(),
          occurredOn: [...dates].sort().at(-1)!,
          attributed: true,
          note: ATTRIBUTION_NOTE,
          detail: {
            RENEWED: "The renewal was recorded as renewed from contract records.",
            EXPANDED: "Expansion was recorded after the flag.",
            CONTRACTED: "A contraction was recorded after the flag.",
            CHURNED: "The account churned after the flag.",
          }[status],
          evidence,
          valueCurrency: status === "EXPANDED" ? expandedCurrency : null,
        }
      : null;
    const prev = r.revenueOutcome as unknown as RevenueCheckpoint | null;
    const same =
      (prev === null && next === null) ||
      (prev !== null &&
        next !== null &&
        prev.status === next.status &&
        prev.occurredOn === next.occurredOn &&
        canonical(prev.evidence) === canonical(next.evidence) &&
        r.valueSavedMinor === valueSaved &&
        r.valueExpandedMinor === valueExpanded);
    if (same) continue;
    await db.$tenantTransaction(async (tx) => {
      await tx.outcomeRecord.update({
        where: { id: r.id },
        data: {
          revenueOutcome: next ? (next as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          valueSavedMinor: valueSaved,
          valueExpandedMinor: valueExpanded,
        },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "outcome.revenue_status",
          targetType: "OutcomeRecord",
          targetId: r.id,
          summary: next
            ? `Revenue outcome ${next.status.toLowerCase()} recorded from ${next.evidence.length} record${next.evidence.length === 1 ? "" : "s"} (attributed, not causal)`
            : "Revenue outcome cleared: the records that supported it no longer apply",
          before: prev ? { status: prev.status } : null,
          after: next ? { status: next.status } : null,
        },
        tx,
      );
    });
    changed++;
  }
  return { evaluated: records.length, changed };
}

export {
  loadLedger,
  loadSaveRecord,
  listAccountOutcomes,
  periodDays,
  LEDGER_PERIOD_DAYS,
  type LedgerActor,
  type LedgerQuery,
  type LedgerView,
  type SaveRecordView,
  type LinkedItem,
} from "./ledger.service";
export {
  buildLedger,
  headlineSentence,
  fmtMoneyTotals,
  isSave,
  filterRecords,
  RECORD_FILTERS,
  type RecordFilter,
  LEDGER_DEFINITIONS,
  LEDGER_LABEL,
  RESTRICTED,
  type Ledger,
  type LedgerCounts,
  type LedgerGroup,
  type LedgerRecord,
  type Moneyish,
} from "./ledger";
