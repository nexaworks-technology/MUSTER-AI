import { classifyAlarm, type LongCheckpoint } from "./checkpoints";

/**
 * M11 S5: how often each signal rule and agent was right (spec §6L3, D-163, D-167). PURE: rows in,
 * numbers out. This measures the models; it never changes them (M11 rule 4). Alarm classification is
 * `classifyAlarm` (D-163), used here and nowhere re-defined.
 */
export interface AccuracyFlag {
  flagType: "RISK" | "OPPORTUNITY";
  signalStatus: string | null;
  /** Frozen at day 90 when determined; takes precedence over re-classifying. */
  isTrueAlarm: boolean | null;
  d90: Pick<LongCheckpoint, "status" | "actionTaken" | "healthAtCheckpoint"> | null;
  ruleKey: string | null;
  agentKey: string | null;
  outcomeRecordId: string;
  signalId: string | null;
  accountId: string;
  flaggedAt: Date;
}

export interface AccuracyApproval {
  approvalId: string;
  accountId: string | null;
  agentKey: string;
  /** Any ApprovalStatus; only APPROVED, EDITED_APPROVED and REJECTED count toward acceptance. */
  status: string;
}

export interface AccuracyThresholds {
  /** Cries wolf when the false-alarm rate is strictly above this share... */
  criesWolfRate: number;
  /** ...and at least this many alarms were determined. */
  criesWolfMinDetermined: number;
}

/** One flag behind a count: the exact record, so a click shows what the number is made of. */
export interface FlagItem {
  outcomeRecordId: string;
  signalId: string | null;
  accountId: string;
  flaggedAt: Date;
  alarm: boolean | null;
}
export interface ApprovalItem {
  approvalId: string;
  accountId: string | null;
  status: string;
}

export interface AccuracyRow {
  /** Every flag counted in true + false + undetermined, one item each. */
  flagItems: FlagItem[];
  /** Every decided approval counted in approved + rejected, one item each. */
  approvalItems: ApprovalItem[];
  key: string;
  trueAlarms: number;
  falseAlarms: number;
  undetermined: number;
  /** true + false: the n behind every rate. */
  determined: number;
  /** false / (true + false); null when nothing is determined, never 0. */
  falseAlarmRate: number | null;
  approved: number;
  rejected: number;
  /** approved / (approved + rejected); null when nobody decided. */
  acceptanceRate: number | null;
  criesWolf: boolean;
}

export interface Accuracy {
  byRule: AccuracyRow[];
  byAgent: AccuracyRow[];
}

/** True / false / undetermined (null) for one flag. */
export function alarmOf(f: AccuracyFlag): boolean | null {
  if (f.flagType !== "RISK") return null;
  if (f.isTrueAlarm !== null) return f.isTrueAlarm;
  return classifyAlarm({ flagType: f.flagType, signalStatus: f.signalStatus, d90: f.d90 });
}

const blank = (key: string): AccuracyRow => ({
  key,
  flagItems: [],
  approvalItems: [],
  trueAlarms: 0,
  falseAlarms: 0,
  undetermined: 0,
  determined: 0,
  falseAlarmRate: null,
  approved: 0,
  rejected: 0,
  acceptanceRate: null,
  criesWolf: false,
});

function finish(row: AccuracyRow, t: AccuracyThresholds): AccuracyRow {
  const determined = row.trueAlarms + row.falseAlarms;
  const falseAlarmRate = determined === 0 ? null : row.falseAlarms / determined;
  const decided = row.approved + row.rejected;
  return {
    ...row,
    determined,
    falseAlarmRate,
    acceptanceRate: decided === 0 ? null : row.approved / decided,
    criesWolf:
      falseAlarmRate !== null &&
      falseAlarmRate > t.criesWolfRate &&
      determined >= t.criesWolfMinDetermined,
  };
}

export function buildAccuracy(
  flags: AccuracyFlag[],
  approvals: AccuracyApproval[],
  thresholds: AccuracyThresholds,
): Accuracy {
  const rules = new Map<string, AccuracyRow>();
  const agents = new Map<string, AccuracyRow>();
  const row = (m: Map<string, AccuracyRow>, k: string) => {
    let r = m.get(k);
    if (!r) m.set(k, (r = blank(k)));
    return r;
  };
  for (const f of flags) {
    if (f.flagType !== "RISK") continue;
    const alarm = alarmOf(f);
    const item: FlagItem = {
      outcomeRecordId: f.outcomeRecordId,
      signalId: f.signalId,
      accountId: f.accountId,
      flaggedAt: f.flaggedAt,
      alarm,
    };
    const bump = (r: AccuracyRow) => {
      r.flagItems.push(item);
      if (alarm === true) r.trueAlarms++;
      else if (alarm === false) r.falseAlarms++;
      else r.undetermined++;
    };
    if (f.ruleKey) bump(row(rules, f.ruleKey));
    if (f.agentKey) bump(row(agents, f.agentKey));
  }
  for (const a of approvals) {
    const r = row(agents, a.agentKey);
    if (a.status === "REJECTED") r.rejected++;
    else if (a.status === "APPROVED" || a.status === "EDITED_APPROVED") r.approved++;
    else continue;
    r.approvalItems.push({ approvalId: a.approvalId, accountId: a.accountId, status: a.status });
  }
  const done = (m: Map<string, AccuracyRow>) =>
    [...m.values()].map((r) => finish(r, thresholds)).sort((a, b) => a.key.localeCompare(b.key));
  return { byRule: done(rules), byAgent: done(agents) };
}
