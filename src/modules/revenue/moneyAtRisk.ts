import type { ConfidenceBand } from "@prisma/client";
import type { CalendarDate } from "@/lib/dates";
import { daysBetween } from "@/lib/dates";

/**
 * Money at risk (spec §6N): the contract value of open renewals inside a window whose account is
 * At Risk on health or whose renewal confidence is LOW. Each item names why. A renewal with no
 * value on file is listed, not counted as zero (Rule 4); other currencies are listed apart, never
 * converted. Pure.
 */
export interface RiskRenewal {
  id: string;
  accountId: string;
  renewalDate: CalendarDate;
  arrMinor: bigint | null;
  currency: string | null;
  band: ConfidenceBand;
  accountRisk: "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA" | null;
}

export interface RiskItem {
  renewalId: string;
  accountId: string;
  reasons: Array<"ACCOUNT_AT_RISK" | "LOW_CONFIDENCE">;
}

export interface MoneyAtRisk {
  windowDays: number;
  baseCurrency: string;
  arrMinor: bigint;
  items: RiskItem[];
  noArrIds: string[];
  otherCurrencies: Array<{ currency: string; arrMinor: bigint; renewalIds: string[] }>;
}

export function moneyAtRisk(
  renewals: readonly RiskRenewal[],
  asOf: CalendarDate,
  windowDays: number,
  baseCurrency: string,
): MoneyAtRisk {
  const out: MoneyAtRisk = {
    windowDays,
    baseCurrency,
    arrMinor: 0n,
    items: [],
    noArrIds: [],
    otherCurrencies: [],
  };
  const others = new Map<string, { arrMinor: bigint; renewalIds: string[] }>();
  for (const r of renewals) {
    const days = daysBetween(asOf, r.renewalDate);
    if (days < 0 || days > windowDays) continue;
    const reasons: RiskItem["reasons"] = [];
    if (r.accountRisk === "AT_RISK") reasons.push("ACCOUNT_AT_RISK");
    if (r.band === "LOW") reasons.push("LOW_CONFIDENCE");
    if (reasons.length === 0) continue;
    out.items.push({ renewalId: r.id, accountId: r.accountId, reasons });
    if (r.arrMinor === null || r.currency === null) out.noArrIds.push(r.id);
    else if (r.currency === baseCurrency) out.arrMinor += r.arrMinor;
    else {
      const o = others.get(r.currency) ?? { arrMinor: 0n, renewalIds: [] };
      o.arrMinor += r.arrMinor;
      o.renewalIds.push(r.id);
      others.set(r.currency, o);
    }
  }
  out.otherCurrencies = [...others]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, v]) => ({ currency, ...v }));
  return out;
}
