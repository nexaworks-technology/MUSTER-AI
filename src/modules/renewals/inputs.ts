import { addDays, type CalendarDate } from "@/lib/dates";
import { currentUsage, typicalWeekday, type AccountBundle } from "@/modules/health/service";
import { championState } from "./champion";
import type { ConfidenceInput, HealthBand, Source } from "./confidence";
import type { ConfidenceConfig } from "./schemas";

/**
 * Turns records into a `ConfidenceInput`. The same builder serves tonight's radar (stored scores
 * and signals) and the back-test (everything recomputed from a bundle cut to a past date), so the
 * two differ only in where `health` and `signals` come from, never in how the rest is read.
 */
export interface RenewalFacts {
  contractId: string;
  renewalDate: CalendarDate;
  noticeDeadline: CalendarDate | null;
}

export function inputFromBundle(args: {
  bundle: AccountBundle;
  renewal: RenewalFacts;
  health: { band: HealthBand; overall: number | null; sources: Source[] } | null;
  /** Overall now minus overall 30 days ago; null when unknown. */
  trend30: number | null;
  signals: ConfidenceInput["signals"];
  plan: ConfidenceInput["plan"];
  cfg: ConfidenceConfig;
}): ConfidenceInput {
  const { bundle: b, renewal, cfg } = args;
  const champion = championState(b, cfg.champion.silentAfterDays);
  return {
    asOf: b.asOf,
    accountId: b.accountId,
    contractId: renewal.contractId,
    renewalDate: renewal.renewalDate,
    noticeDeadline: renewal.noticeDeadline,
    health: args.health ? { ...args.health, trend30: args.trend30 } : null,
    signals: args.signals,
    champion: champion
      ? {
          state: champion.state,
          name: champion.name,
          silentDays: champion.silentDays,
          sources: champion.sources,
        }
      : null,
    invoices: b.invoices.map((i) => ({
      id: i.id,
      number: i.number,
      issuedDate: i.issuedDate,
      dueDate: i.dueDate,
      paidDate: i.paidDate,
      failedDate: i.failedDate,
      isVoid: i.isVoid,
    })),
    plan: args.plan,
    usage: usageAgainstNormal(b),
  };
}

/** The same current-vs-normal comparison the usage-drop rule makes, so the two read alike. */
export function usageAgainstNormal(b: AccountBundle): ConfidenceInput["usage"] {
  const w = currentUsage(b, 3);
  const base = b.ownBaseline;
  if (!w.ok || !base || base.historyDays < 28 || base.median === null) return null;
  const rows = (b.usage ?? []).filter((u) => u.date <= b.asOf);
  const current = (typicalWeekday(rows, w.to) + typicalWeekday(rows, addDays(w.to, -7))) / 2;
  return {
    current,
    normal: base.median,
    sources: [
      { sourceType: "UsageDaily", accountId: b.accountId, from: addDays(w.to, -13), to: w.to },
      { sourceType: "UsageDaily", accountId: b.accountId, from: base.from, to: base.to },
    ],
  };
}

/** Risk signals (live rows or as-of candidates) in the shape the confidence function reads. */
export function toFactorSignals(
  list: Array<{
    key: string;
    severity: "WARN" | "CRITICAL";
    title: string;
    sources: Source[];
  }>,
): NonNullable<ConfidenceInput["signals"]> {
  return list;
}
