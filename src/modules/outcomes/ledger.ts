import { formatMoney, type Money } from "@/lib/money";
import type { CalendarDate } from "@/lib/dates";

/**
 * M11 S3: the "Did it work?" ledger arithmetic (spec §6L3, Q-15, D-162). Pure: plain rows in,
 * counts and money out; `ledger.service.ts` loads the rows. This file is the only source of money
 * on the ledger screens.
 *
 * Cohort (decided): RISK flags whose frozen day-90 checkpoint is due inside the period. Flags
 * still waiting for day 90 are counted as `awaiting` and never guessed. Saved = the team acted AND
 * the day-90 status is RECOVERED or RENEWED; its money is the ARR at the flag, per currency (never
 * converted). A save with no ARR on file counts but adds no money (never 0, Rule 4). Attributed,
 * not proven causal (Q-15). Without revenue access every money field is the RESTRICTED marker
 * (counts stay).
 */
export const RESTRICTED = "RESTRICTED" as const;
export type Restricted = typeof RESTRICTED;

export const LEDGER_DEFINITIONS = {
  saved:
    "ARR at the flag, for risks the team acted on that recovered or renewed by day 90. Attributed, not proven causal (Q-15).",
  renewalSaved:
    "Renewal saved: ARR at the flag, for risks the team acted on that renewed within 90 days (renewals only).",
  expanded:
    "Positive expansion events on the account after the flag, for opportunities the team acted on that expanded by day 90. Attributed, not proven causal (Q-15).",
  awaiting: "Flags still waiting for their 90-day checkpoint; not counted anywhere else.",
} as const;

export const LEDGER_LABEL = "attributed, not proven causal";

export interface LedgerD90 {
  status: string;
  actionTaken: "ACTED" | "IGNORED";
  dueOn: CalendarDate;
  evidence: Array<{ sourceType: string; sourceId: string }>;
}

export interface LedgerRow {
  id: string;
  accountId: string;
  flagType: "RISK" | "OPPORTUNITY";
  flaggedAt: Date;
  /** Null = no ARR on file (never 0). */
  arrAtFlagMinor: bigint | null;
  arrCurrency: string | null;
  signalId: string | null;
  ruleKey: string | null;
  agentKey: string | null;
  /** The one play (if any) the flag's actions came from. */
  playKey: string | null;
  d90: LedgerD90 | null;
  /** Deltas of the cited RevenueEvents (already loaded); only positive ones count as expansion. */
  expansionDeltas: Array<{ currency: string; minor: bigint }>;
}

export type MoneyTotals = Money[];
export type Moneyish = MoneyTotals | Restricted;

export interface LedgerCounts {
  flagged: number;
  acted: number;
  ignored: number;
  recoveredOrRenewed: number;
  savedCount: number;
  savedWithoutArr: number;
  savedMinor: Moneyish;
  churned: number;
  contracted: number;
  awaiting: number;
  opportunityFlagged: number;
  expandedCount: number;
  expandedMinor: Moneyish;
}

export interface LedgerRecord {
  id: string;
  accountId: string;
  flagType: "RISK" | "OPPORTUNITY";
  flaggedAt: Date;
  signalId: string | null;
  status: string | null;
  actionTaken: "ACTED" | "IGNORED" | null;
  saved: boolean;
  arrAtFlagMinor: bigint | null | Restricted;
  arrCurrency: string | null;
  /** The money this record saved: null when it saved nothing or has no ARR. */
  savedMoney: Money | null | Restricted;
}

export interface LedgerGroup {
  key: string;
  counts: LedgerCounts;
}

export interface Ledger {
  period: { from: CalendarDate; to: CalendarDate };
  moneyVisible: boolean;
  totals: LedgerCounts;
  records: LedgerRecord[];
  byAccount: LedgerGroup[];
  byPlay: LedgerGroup[];
  byAgent: LedgerGroup[];
  byRule: LedgerGroup[];
}

interface Acc {
  c: Omit<LedgerCounts, "savedMinor" | "expandedMinor">;
  saved: Map<string, bigint>;
  expanded: Map<string, bigint>;
}

const newAcc = (): Acc => ({
  c: {
    flagged: 0,
    acted: 0,
    ignored: 0,
    recoveredOrRenewed: 0,
    savedCount: 0,
    savedWithoutArr: 0,
    churned: 0,
    contracted: 0,
    awaiting: 0,
    opportunityFlagged: 0,
    expandedCount: 0,
  },
  saved: new Map(),
  expanded: new Map(),
});

const add = (m: Map<string, bigint>, currency: string, minor: bigint) =>
  m.set(currency, (m.get(currency) ?? 0n) + minor);

const toMoney = (m: Map<string, bigint>): MoneyTotals =>
  [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, minor]) => ({ currency, minor }));

export const isSave = (r: Pick<LedgerRow, "flagType" | "d90">): boolean =>
  r.flagType === "RISK" &&
  r.d90 !== null &&
  r.d90.actionTaken === "ACTED" &&
  (r.d90.status === "RECOVERED" || r.d90.status === "RENEWED");

function tally(acc: Acc, r: LedgerRow, inCohort: boolean): void {
  if (r.flagType === "RISK" && r.d90 === null) {
    acc.c.awaiting += 1;
    return;
  }
  if (!inCohort || !r.d90) return;
  if (r.flagType === "OPPORTUNITY") {
    acc.c.opportunityFlagged += 1;
    if (r.d90.actionTaken === "ACTED" && r.d90.status === "EXPANDED") {
      acc.c.expandedCount += 1;
      for (const d of r.expansionDeltas) if (d.minor > 0n) add(acc.expanded, d.currency, d.minor);
    }
    return;
  }
  acc.c.flagged += 1;
  if (r.d90.actionTaken === "ACTED") acc.c.acted += 1;
  else acc.c.ignored += 1;
  if (r.d90.status === "RECOVERED" || r.d90.status === "RENEWED") acc.c.recoveredOrRenewed += 1;
  if (r.d90.status === "CHURNED") acc.c.churned += 1;
  if (r.d90.status === "CONTRACTED") acc.c.contracted += 1;
  if (isSave(r)) {
    acc.c.savedCount += 1;
    if (r.arrAtFlagMinor !== null && r.arrCurrency !== null)
      add(acc.saved, r.arrCurrency, r.arrAtFlagMinor);
    else acc.c.savedWithoutArr += 1;
  }
}

function finish(acc: Acc, visible: boolean): LedgerCounts {
  return {
    ...acc.c,
    savedMinor: visible ? toMoney(acc.saved) : RESTRICTED,
    expandedMinor: visible ? toMoney(acc.expanded) : RESTRICTED,
  };
}

/** Builds the ledger from rows. `from`/`to` are workspace business dates (inclusive). */
export function buildLedger(
  rows: readonly LedgerRow[],
  opts: { from: CalendarDate; to: CalendarDate; canViewRevenue: boolean },
): Ledger {
  const visible = opts.canViewRevenue;
  const inCohort = (r: LedgerRow) =>
    r.d90 !== null && r.d90.dueOn >= opts.from && r.d90.dueOn <= opts.to;
  const total = newAcc();
  const groups = {
    account: new Map<string, Acc>(),
    play: new Map<string, Acc>(),
    agent: new Map<string, Acc>(),
    rule: new Map<string, Acc>(),
  };
  const records: LedgerRecord[] = [];
  const bump = (g: Map<string, Acc>, key: string, r: LedgerRow, c: boolean) => {
    let a = g.get(key);
    if (!a) g.set(key, (a = newAcc()));
    tally(a, r, c);
  };
  for (const r of rows) {
    const c = inCohort(r);
    if (!c && !(r.flagType === "RISK" && r.d90 === null)) continue;
    tally(total, r, c);
    bump(groups.account, r.accountId, r, c);
    bump(groups.play, r.playKey ?? "none", r, c);
    bump(
      groups.agent,
      r.agentKey ? `agent:${r.agentKey}` : r.ruleKey ? `rule:${r.ruleKey}` : "unknown",
      r,
      c,
    );
    bump(groups.rule, r.ruleKey ?? "none", r, c);
    if (c && r.d90) {
      const saved = isSave(r);
      const hasArr = r.arrAtFlagMinor !== null && r.arrCurrency !== null;
      records.push({
        id: r.id,
        accountId: r.accountId,
        flagType: r.flagType,
        flaggedAt: r.flaggedAt,
        signalId: r.signalId,
        status: r.d90.status,
        actionTaken: r.d90.actionTaken,
        saved,
        arrAtFlagMinor: visible ? r.arrAtFlagMinor : RESTRICTED,
        arrCurrency: r.arrCurrency,
        savedMoney:
          saved && hasArr
            ? visible
              ? { minor: r.arrAtFlagMinor!, currency: r.arrCurrency! }
              : RESTRICTED
            : null,
      });
    }
  }
  const list = (m: Map<string, Acc>): LedgerGroup[] =>
    [...m.entries()]
      .map(([key, a]) => ({ key, counts: finish(a, visible) }))
      .sort((a, b) => b.counts.flagged - a.counts.flagged || (a.key < b.key ? -1 : 1));
  return {
    period: { from: opts.from, to: opts.to },
    moneyVisible: visible,
    totals: finish(total, visible),
    records,
    byAccount: list(groups.account),
    byPlay: list(groups.play),
    byAgent: list(groups.agent),
    byRule: list(groups.rule),
  };
}

export const fmtMoneyTotals = (m: Moneyish): string =>
  m === RESTRICTED ? "Restricted" : m.length === 0 ? "—" : m.map((x) => formatMoney(x)).join(" + ");

export interface Headline {
  text: string;
  label: string;
  definition: string;
  empty: boolean;
}

/** The headline sentence, computed from the ledger so its numbers always equal the counts. */
export function headlineSentence(ledger: Ledger, days: number): Headline {
  const t = ledger.totals;
  const base = { label: LEDGER_LABEL, definition: LEDGER_DEFINITIONS.saved };
  if (t.flagged === 0)
    return { ...base, text: "No flags have reached their 90-day checkpoint yet", empty: true };
  let text =
    `Of ${t.flagged} ${t.flagged === 1 ? "risk that reached" : "risks that reached"} their 90-day ` +
    `checkpoint in the last ${days} days, the team acted on ${t.acted}; ` +
    `${t.recoveredOrRenewed} recovered or renewed`;
  const hasMoney = t.savedMinor === RESTRICTED ? t.savedCount > 0 : t.savedMinor.length > 0;
  if (hasMoney) text += ` — worth ${fmtMoneyTotals(t.savedMinor)}`;
  return { ...base, text: `${text}.`, empty: false };
}

export const RECORD_FILTERS = [
  "all",
  "acted",
  "ignored",
  "recovered",
  "saved",
  "churned",
  "contracted",
  "expanded",
] as const;
export type RecordFilter = (typeof RECORD_FILTERS)[number];

/** The records behind one figure: each count on the page links to the filter that lists them. */
export function filterRecords(
  records: readonly LedgerRecord[],
  show: RecordFilter,
): LedgerRecord[] {
  const risk = (r: LedgerRecord) => r.flagType === "RISK";
  return records.filter((r) => {
    switch (show) {
      case "all":
        return true;
      case "acted":
        return risk(r) && r.actionTaken === "ACTED";
      case "ignored":
        return risk(r) && r.actionTaken === "IGNORED";
      case "recovered":
        return risk(r) && (r.status === "RECOVERED" || r.status === "RENEWED");
      case "saved":
        return r.saved;
      case "churned":
        return risk(r) && r.status === "CHURNED";
      case "contracted":
        return risk(r) && r.status === "CONTRACTED";
      case "expanded":
        return !risk(r) && r.actionTaken === "ACTED" && r.status === "EXPANDED";
    }
  });
}
