import type { ConfidenceBand, ForecastCategory } from "@prisma/client";

/**
 * The renewal forecast (spec §6N): sums of open renewals' ARR by computed confidence band and by
 * the human forecast category, each listing the renewal ids that make it up (Rule 1). Pure, no
 * database. Money is minor units (BigInt) in the workspace base currency; renewals in another
 * currency are listed separately and never converted; renewals with no ARR on file are listed,
 * never counted as zero (Rule 4).
 */
export type ForecastRenewal = {
  id: string;
  arrMinor: bigint | null;
  currency: string | null;
  band: ConfidenceBand;
  category: ForecastCategory | null;
};

export type ForecastBucket = { arrMinor: bigint; renewalIds: string[] };

export type Forecast = {
  baseCurrency: string;
  byBand: Record<ConfidenceBand, ForecastBucket>;
  /** Renewals the owner has not categorised sit under `UNSET`; OMITTED renewals are left out. */
  byCategory: Record<Exclude<ForecastCategory, "OMITTED"> | "UNSET", ForecastBucket>;
  omittedIds: string[];
  otherCurrencies: Array<{ currency: string; arrMinor: bigint; renewalIds: string[] }>;
  noArrIds: string[];
};

/** The category each computed band would suggest; a human category that differs is flagged. */
export const BAND_SUGGESTS: Record<ConfidenceBand, Exclude<ForecastCategory, "OMITTED">> = {
  HIGH: "COMMIT",
  MEDIUM: "BEST_CASE",
  LOW: "AT_RISK",
};

export function disagreement(
  band: ConfidenceBand,
  category: ForecastCategory | null,
): { band: ConfidenceBand; suggests: ForecastCategory; chosen: ForecastCategory } | null {
  if (category === null || category === "OMITTED") return null;
  const suggests = BAND_SUGGESTS[band];
  return suggests === category ? null : { band, suggests, chosen: category };
}

const bucket = (): ForecastBucket => ({ arrMinor: 0n, renewalIds: [] });
const add = (b: ForecastBucket, r: ForecastRenewal) => {
  b.arrMinor += r.arrMinor ?? 0n;
  b.renewalIds.push(r.id);
};

export function forecast(renewals: readonly ForecastRenewal[], baseCurrency: string): Forecast {
  const out: Forecast = {
    baseCurrency,
    byBand: { HIGH: bucket(), MEDIUM: bucket(), LOW: bucket() },
    byCategory: {
      COMMIT: bucket(),
      BEST_CASE: bucket(),
      AT_RISK: bucket(),
      UNSET: bucket(),
    },
    omittedIds: [],
    otherCurrencies: [],
    noArrIds: [],
  };
  const others = new Map<string, { arrMinor: bigint; renewalIds: string[] }>();
  for (const r of renewals) {
    if (r.arrMinor === null || r.currency === null) {
      out.noArrIds.push(r.id);
      continue;
    }
    if (r.currency !== baseCurrency) {
      const o = others.get(r.currency) ?? { arrMinor: 0n, renewalIds: [] };
      o.arrMinor += r.arrMinor;
      o.renewalIds.push(r.id);
      others.set(r.currency, o);
      continue;
    }
    if (r.category === "OMITTED") {
      out.omittedIds.push(r.id);
      continue;
    }
    add(out.byBand[r.band], r);
    add(out.byCategory[r.category ?? "UNSET"], r);
  }
  out.otherCurrencies = [...others.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, v]) => ({ currency, ...v }));
  return out;
}
