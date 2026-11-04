import type { CalendarDate } from "@/lib/dates";
import { currentContract, type ContractFacts } from "@/modules/billing/service";

/**
 * The ARR waterfall (spec §6N, M7 rule 3, D9): opening ARR + new + expansion − contraction −
 * churn + reactivation = closing ARR, in the minor unit, exactly. Opening is the sum of every
 * revenue event dated before the period starts, per currency, so there is no separately stored
 * figure to drift from the events. Each movement lists the event ids behind it (Rule 1).
 * Currencies are never converted: the base currency is the headline, any other is its own table.
 * Pure, BigInt arithmetic throughout.
 */
export type EventType = "NEW" | "EXPANSION" | "CONTRACTION" | "CHURN" | "REACTIVATION";

export interface WaterfallEvent {
  id: string;
  accountId: string;
  type: EventType;
  deltaArrMinor: bigint;
  currency: string;
  effectiveDate: CalendarDate;
}

export interface Movement {
  amountMinor: bigint;
  eventIds: string[];
}

export interface CurrencyWaterfall {
  currency: string;
  openingMinor: bigint;
  new: Movement;
  expansion: Movement;
  contraction: Movement;
  churn: Movement;
  reactivation: Movement;
  closingMinor: bigint;
  /** closing equals the sum of every event on or before the period end, checked independently. */
  reconciled: boolean;
  /** Events whose sign contradicts their type (e.g. a negative expansion): shown, never hidden. */
  anomalies: string[];
}

export interface Waterfall {
  from: CalendarDate;
  to: CalendarDate;
  baseCurrency: string;
  base: CurrencyWaterfall;
  otherCurrencies: CurrencyWaterfall[];
}

const KEYS = {
  NEW: "new",
  EXPANSION: "expansion",
  CONTRACTION: "contraction",
  CHURN: "churn",
  REACTIVATION: "reactivation",
} as const;

const SIGN_OK: Record<EventType, (d: bigint) => boolean> = {
  NEW: (d) => d >= 0n,
  EXPANSION: (d) => d > 0n,
  REACTIVATION: (d) => d >= 0n,
  CONTRACTION: (d) => d < 0n,
  CHURN: (d) => d <= 0n,
};

const empty = (): Movement => ({ amountMinor: 0n, eventIds: [] });

function one(events: readonly WaterfallEvent[], currency: string, from: string, to: string) {
  const w: CurrencyWaterfall = {
    currency,
    openingMinor: 0n,
    new: empty(),
    expansion: empty(),
    contraction: empty(),
    churn: empty(),
    reactivation: empty(),
    closingMinor: 0n,
    reconciled: false,
    anomalies: [],
  };
  let allUpToEnd = 0n;
  for (const e of events) {
    if (e.currency !== currency || e.effectiveDate > to) continue;
    allUpToEnd += e.deltaArrMinor;
    if (!SIGN_OK[e.type](e.deltaArrMinor)) w.anomalies.push(e.id);
    if (e.effectiveDate < from) {
      w.openingMinor += e.deltaArrMinor;
      continue;
    }
    const m = w[KEYS[e.type]];
    m.amountMinor += e.deltaArrMinor;
    m.eventIds.push(e.id);
  }
  w.closingMinor =
    w.openingMinor +
    w.new.amountMinor +
    w.expansion.amountMinor +
    w.contraction.amountMinor +
    w.churn.amountMinor +
    w.reactivation.amountMinor;
  w.reconciled = w.closingMinor === allUpToEnd;
  return w;
}

export function waterfall(
  events: readonly WaterfallEvent[],
  period: { from: CalendarDate; to: CalendarDate },
  baseCurrency: string,
): Waterfall {
  const others = [...new Set(events.map((e) => e.currency))]
    .filter((c) => c !== baseCurrency)
    .sort();
  return {
    from: period.from,
    to: period.to,
    baseCurrency,
    base: one(events, baseCurrency, period.from, period.to),
    otherCurrencies: others.map((c) => one(events, c, period.from, period.to)),
  };
}

// ─── Cross-check against contract-based ARR (D9) ─────────────────────────────

export interface ArrMismatch {
  accountId: string;
  currency: string;
  /** Sum of the account's revenue events on or before the date. */
  eventsMinor: bigint;
  /** Value of the contract in force; 0 when none is. */
  contractMinor: bigint;
  eventIds: string[];
  contractId: string | null;
}

export type ContractWithAccount = ContractFacts & { accountId: string };

/**
 * Per account and currency, ARR from revenue events must equal the value of the contract in
 * force. A current contract with no value on file is skipped (nothing to compare, Rule 4). A
 * difference is a data-quality item, never silently resolved.
 */
export function arrMismatches(
  events: readonly WaterfallEvent[],
  contracts: readonly ContractWithAccount[],
  asOf: CalendarDate,
): ArrMismatch[] {
  const at = new Date(`${asOf}T00:00:00Z`);
  const keys = new Map<string, { accountId: string; currency: string }>();
  const sums = new Map<string, { sum: bigint; ids: string[] }>();
  for (const e of events) {
    if (e.effectiveDate > asOf) continue;
    const k = `${e.accountId}|${e.currency}`;
    keys.set(k, { accountId: e.accountId, currency: e.currency });
    const s = sums.get(k) ?? { sum: 0n, ids: [] };
    s.sum += e.deltaArrMinor;
    s.ids.push(e.id);
    sums.set(k, s);
  }
  const byAccount = new Map<string, ContractWithAccount[]>();
  for (const c of contracts) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
  const current = new Map<string, ContractWithAccount | null>();
  for (const [a, cs] of byAccount) current.set(a, currentContract(cs, at));
  for (const [a, c] of current)
    if (c && c.valueMinor !== null)
      keys.set(`${a}|${c.currency}`, { accountId: a, currency: c.currency });

  const out: ArrMismatch[] = [];
  for (const [k, { accountId, currency }] of keys) {
    const cur = current.get(accountId) ?? null;
    if (cur && cur.valueMinor === null) continue;
    const contractMinor = cur && cur.currency === currency ? cur.valueMinor! : 0n;
    const s = sums.get(k) ?? { sum: 0n, ids: [] };
    if (s.sum !== contractMinor)
      out.push({
        accountId,
        currency,
        eventsMinor: s.sum,
        contractMinor,
        eventIds: s.ids,
        contractId: cur && cur.currency === currency ? cur.id : null,
      });
  }
  return out.sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency),
  );
}
