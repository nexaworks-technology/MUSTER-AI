import { addDays, type CalendarDate } from "@/lib/dates";

/**
 * M11 S2: the 30/90-day outcome checkpoints (spec §6L3, ARCHITECTURE §6.5, D-161). Each is a
 * frozen comparison between what was flagged (the prediction side: the signal and the health band
 * at the flag) and what the records show by the checkpoint date (the outcome side, with evidence
 * ids). Pure functions here; `checkpoints.service.ts` loads the facts and stores the result once
 * (a DB trigger refuses any rewrite).
 *
 * Precedence, one status per checkpoint: CHURNED > CONTRACTED > RENEWED (risk) / EXPANDED
 * (opportunity) > RECOVERED (risk) > MEETING_HELD > REPLIED > NO_CHANGE. No data → NO_CHANGE with
 * evidence [] — that is a result, not a failure (Rule 4). Attributed, never causal (Q-15).
 */
export type CheckpointDay = 30 | 90;
export type LongStatus =
  | "REPLIED"
  | "MEETING_HELD"
  | "RECOVERED"
  | "RENEWED"
  | "EXPANDED"
  | "CONTRACTED"
  | "CHURNED"
  | "NO_CHANGE";
export type RevenueStatus = "RENEWED" | "EXPANDED" | "CONTRACTED" | "CHURNED";
export type RiskLevel = string;

export interface EvidenceRef {
  sourceType: string;
  sourceId: string;
}

export interface RenewalOutcomeFact {
  id: string;
  result: string;
  on: CalendarDate;
  supersedesId: string | null;
}
export interface RevenueEventFact {
  id: string;
  type: "EXPANSION" | "CONTRACTION" | "CHURN";
  on: CalendarDate;
  deltaArrMinor: bigint;
}

export interface CheckpointFacts {
  day: CheckpointDay;
  signalId: string | null;
  flagType: "RISK" | "OPPORTUNITY";
  flaggedAt: Date;
  /** The flag's business date in the workspace time zone. */
  flaggedOn: CalendarDate;
  /** flaggedOn + day (business date). */
  dueOn: CalendarDate;
  /** The instant the checkpoint's business day ends (start of dueOn + 1, workspace tz). */
  windowEnd: Date;
  firstActionAt: Date | null;
  /** Inbound messages from the account. */
  messages: Array<{ id: string; at: Date }>;
  /** Completed meetings with the account. */
  meetings: Array<{ id: string; at: Date }>;
  /** Live health snapshots (never back-test rows, D-158), any order. */
  snapshots: Array<{ id: string; on: CalendarDate; riskLevel: RiskLevel }>;
  renewalOutcomes: RenewalOutcomeFact[];
  revenueEvents: RevenueEventFact[];
}

export interface HealthRef {
  snapshotId: string;
  riskLevel: RiskLevel;
}

export interface LongCheckpoint {
  day: CheckpointDay;
  status: LongStatus;
  dueOn: CalendarDate;
  evaluatedAt?: string;
  /** Acted by the checkpoint (first action inside the window), else IGNORED. */
  actionTaken: "ACTED" | "IGNORED";
  /** The prediction side, frozen as it stood at the flag. */
  prediction: {
    signalId: string | null;
    flagType: "RISK" | "OPPORTUNITY";
    flaggedAt: string;
    healthAtFlag: HealthRef | null;
  };
  healthAtCheckpoint: HealthRef | null;
  evidence: EvidenceRef[];
  detail: string;
  attributed: true;
  note: string;
}

export const CHECKPOINT_DAYS: readonly CheckpointDay[] = [30, 90];
/** A checkpoint is evaluated a week after its date so late-recorded renewals still count (as M7). */
export const CHECKPOINT_GRACE_DAYS = 7;
/** RECOVERED: the better band must hold for the last 14 days up to the checkpoint. */
export const RECOVERY_HOLD_DAYS = 14;
const NOTE =
  "Attributed to the flag from records up to the checkpoint; not proven to be caused by it (Q-15).";
const RANK: Record<string, number> = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 };
const rank = (r: RiskLevel) => RANK[r] ?? -1;

export function checkpointDue(
  flaggedOn: CalendarDate,
  day: CheckpointDay,
  today: CalendarDate,
): { dueOn: CalendarDate; due: boolean } {
  const dueOn = addDays(flaggedOn, day);
  return { dueOn, due: today >= addDays(dueOn, CHECKPOINT_GRACE_DAYS) };
}

/**
 * The revenue status inside a window, shared with M7's revenue checkpoint so the two can never
 * disagree on the same records: CHURNED > CONTRACTED > RENEWED (risk) / EXPANDED (opportunity).
 * Renewal outcomes corrected by a later row (supersedesId) do not count.
 */
export function revenueStatusOf(
  flagType: "RISK" | "OPPORTUNITY",
  outcomes: RenewalOutcomeFact[],
  events: RevenueEventFact[],
): { status: RevenueStatus; evidence: EvidenceRef[]; dates: CalendarDate[] } | null {
  const superseded = new Set(outcomes.flatMap((o) => (o.supersedesId ? [o.supersedesId] : [])));
  const effective = outcomes.filter((o) => !superseded.has(o.id));
  const ro = (xs: Array<{ id: string }>) =>
    xs.map((x) => ({ sourceType: "RenewalOutcome", sourceId: x.id }));
  const re = (xs: Array<{ id: string }>) =>
    xs.map((x) => ({ sourceType: "RevenueEvent", sourceId: x.id }));
  const churnedO = effective.filter((o) => o.result === "CHURNED");
  const churnedE = events.filter((e) => e.type === "CHURN");
  if (churnedO.length || churnedE.length)
    return {
      status: "CHURNED",
      evidence: [...ro(churnedO), ...re(churnedE)],
      dates: [...churnedO, ...churnedE].map((x) => x.on),
    };
  const contracted = events.filter((e) => e.type === "CONTRACTION");
  if (contracted.length)
    return { status: "CONTRACTED", evidence: re(contracted), dates: contracted.map((x) => x.on) };
  const renewed = effective.filter((o) => o.result === "RENEWED");
  if (flagType === "RISK" && renewed.length)
    return { status: "RENEWED", evidence: ro(renewed), dates: renewed.map((x) => x.on) };
  const expanded = events.filter((e) => e.type === "EXPANSION" && e.deltaArrMinor > 0n);
  if (flagType === "OPPORTUNITY" && expanded.length)
    return { status: "EXPANDED", evidence: re(expanded), dates: expanded.map((x) => x.on) };
  return null;
}

const REVENUE_DETAIL: Record<RevenueStatus, string> = {
  RENEWED: "The renewal was recorded as renewed from contract records.",
  EXPANDED: "Expansion was recorded after the flag.",
  CONTRACTED: "A contraction was recorded after the flag.",
  CHURNED: "The account churned after the flag.",
};

export function decideCheckpoint(f: CheckpointFacts): LongCheckpoint {
  const inDays = (on: CalendarDate) => on >= f.flaggedOn && on <= f.dueOn;
  const snaps = [...f.snapshots]
    .filter((s) => s.on <= f.dueOn)
    .sort((a, b) => (a.on < b.on ? -1 : 1));
  const atFlag = [...snaps].reverse().find((s) => s.on <= f.flaggedOn) ?? null;
  const atCheckpoint = snaps.at(-1) ?? null;
  const ref = (s: (typeof snaps)[number] | null): HealthRef | null =>
    s ? { snapshotId: s.id, riskLevel: s.riskLevel } : null;
  const acted = f.firstActionAt !== null && f.firstActionAt < f.windowEnd;
  const base = {
    day: f.day,
    dueOn: f.dueOn,
    actionTaken: acted ? ("ACTED" as const) : ("IGNORED" as const),
    prediction: {
      signalId: f.signalId,
      flagType: f.flagType,
      flaggedAt: f.flaggedAt.toISOString(),
      healthAtFlag: ref(atFlag),
    },
    healthAtCheckpoint: ref(atCheckpoint),
    attributed: true as const,
    note: NOTE,
  };

  const revenue = revenueStatusOf(
    f.flagType,
    f.renewalOutcomes.filter((o) => inDays(o.on)),
    f.revenueEvents.filter((e) => inDays(e.on)),
  );
  if (revenue)
    return {
      ...base,
      status: revenue.status,
      evidence: revenue.evidence,
      detail: REVENUE_DETAIL[revenue.status],
    };

  if (f.flagType === "RISK" && atFlag) {
    const after = snaps.filter((s) => s.on > f.flaggedOn);
    let lastWorse = -1;
    after.forEach((s, i) => {
      if (rank(s.riskLevel) <= rank(atFlag.riskLevel)) lastWorse = i;
    });
    const run = after.slice(lastWorse + 1);
    const holdFrom = addDays(f.dueOn, -RECOVERY_HOLD_DAYS);
    if (run.length > 0 && run[0]!.on <= holdFrom)
      return {
        ...base,
        status: "RECOVERED",
        evidence: [atFlag, ...run].map((s) => ({
          sourceType: "HealthScoreSnapshot",
          sourceId: s.id,
        })),
        detail: `Health improved from ${atFlag.riskLevel} and held for at least ${RECOVERY_HOLD_DAYS} days up to the checkpoint.`,
      };
  }

  if (acted) {
    const after = <T extends { at: Date }>(xs: T[]) =>
      xs.filter((x) => x.at > f.firstActionAt! && x.at < f.windowEnd).sort((a, b) => +a.at - +b.at);
    const meeting = after(f.meetings)[0];
    if (meeting)
      return {
        ...base,
        status: "MEETING_HELD",
        evidence: [{ sourceType: "Meeting", sourceId: meeting.id }],
        detail: "A meeting with the account was held after the first action.",
      };
    const reply = after(f.messages)[0];
    if (reply)
      return {
        ...base,
        status: "REPLIED",
        evidence: [{ sourceType: "Message", sourceId: reply.id }],
        detail: "The account wrote back after the first action.",
      };
  }

  return {
    ...base,
    status: "NO_CHANGE",
    evidence: [],
    detail: "No revenue change, lasting recovery, meeting or reply on record by the checkpoint.",
  };
}

/**
 * True / false alarm (Q-16 as founder-decided 2026-11-05, D-163). The one place the definition
 * lives. Outcome first: a RISK flag whose d90 outcome is CHURNED or CONTRACTED is a true alarm even
 * if a CSM had marked it false. Then: marked FALSE_ALARM → false; healthy at d90 and renewed with
 * no action → false. Everything else (and every opportunity flag) is undetermined (null).
 */
export function classifyAlarm(input: {
  flagType: "RISK" | "OPPORTUNITY";
  signalStatus: string | null;
  d90: Pick<LongCheckpoint, "status" | "actionTaken" | "healthAtCheckpoint"> | null;
}): boolean | null {
  if (input.flagType !== "RISK") return null;
  const d90 = input.d90;
  if (d90 && (d90.status === "CHURNED" || d90.status === "CONTRACTED")) return true;
  if (input.signalStatus === "FALSE_ALARM") return false;
  if (
    d90 &&
    d90.status === "RENEWED" &&
    d90.actionTaken === "IGNORED" &&
    d90.healthAtCheckpoint?.riskLevel === "HEALTHY"
  )
    return false;
  return null;
}
