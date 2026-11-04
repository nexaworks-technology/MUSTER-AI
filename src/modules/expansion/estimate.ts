/**
 * Expansion estimates (M7 B2, spec §5, CLAUDE.md rules 1 and 4). Money here comes from one place
 * only: the account's own subscription pricing. Never from our pricing config, never from a model.
 * A figure is always an estimate (`isEstimate` is the constant true) and always carries its method;
 * with no usable price the number is null and the label says "No price on file" (never 0).
 * Pure: the caller loads the records.
 */
export interface PricedSubscription {
  id: string;
  status: "ACTIVE" | "PAST_DUE" | "CANCELLED" | "ENDED";
  interval: "MONTH" | "YEAR";
  amountMinor: bigint;
  currency: string;
  quantity: number;
  contractId: string | null;
}

export interface SeatEstimateInput {
  seatsPurchased: number | null;
  seatsUsed: number | null;
  /** The contract in force; its linked subscription is preferred over an unlinked one. */
  contractId: string | null;
  subscriptions: PricedSubscription[];
}

export interface Estimate {
  method: "SEATS_OVER_LIMIT" | "TIER_UPGRADE_DELTA";
  estimateMinor: bigint | null;
  currency: string | null;
  isEstimate: true;
  label: "Estimate" | "No price on file";
}

export interface SeatsOverEstimate extends Estimate {
  method: "SEATS_OVER_LIMIT";
  extraSeats: number;
  perSeatMinor: bigint | null;
  sources: Array<{ sourceType: "Subscription"; sourceId: string }>;
}

const LIVE = new Set(["ACTIVE", "PAST_DUE"]);

/** Annual price per seat from the one live subscription that prices them; null when it is not clear. */
export function perSeatAnnual(
  subscriptions: PricedSubscription[],
  contractId: string | null,
): { perSeatMinor: bigint; currency: string; subscriptionId: string } | null {
  const live = subscriptions.filter(
    (s) => LIVE.has(s.status) && s.quantity > 0 && s.amountMinor > 0n,
  );
  const linked = contractId ? live.filter((s) => s.contractId === contractId) : [];
  const pool = linked.length > 0 ? linked : live.filter((s) => s.contractId === null);
  if (pool.length !== 1) return null;
  const s = pool[0]!;
  const annual = s.amountMinor * (s.interval === "MONTH" ? 12n : 1n);
  const q = BigInt(s.quantity);
  // Rounded half up to the minor unit; exact for the usual whole-price-per-seat case.
  return { perSeatMinor: (annual * 2n + q) / (2n * q), currency: s.currency, subscriptionId: s.id };
}

/** SEATS_OVER_LIMIT: extra seats × the current per-seat price from their own subscription. */
export function estimateSeatsOverLimit(i: SeatEstimateInput): SeatsOverEstimate | null {
  if (i.seatsPurchased === null || i.seatsUsed === null || i.seatsUsed <= i.seatsPurchased)
    return null;
  const extraSeats = i.seatsUsed - i.seatsPurchased;
  const price = perSeatAnnual(i.subscriptions, i.contractId);
  if (!price)
    return {
      method: "SEATS_OVER_LIMIT",
      estimateMinor: null,
      currency: null,
      isEstimate: true,
      label: "No price on file",
      extraSeats,
      perSeatMinor: null,
      sources: [],
    };
  return {
    method: "SEATS_OVER_LIMIT",
    estimateMinor: BigInt(extraSeats) * price.perSeatMinor,
    currency: price.currency,
    isEstimate: true,
    label: "Estimate",
    extraSeats,
    perSeatMinor: price.perSeatMinor,
    sources: [{ sourceType: "Subscription", sourceId: price.subscriptionId }],
  };
}

/**
 * TIER_UPGRADE_DELTA: the difference between the next plan's annual price and the current one, both
 * taken from THEIR subscription data (D6). No source for the next plan's price exists yet, so
 * callers pass null and the result is "No price on file"; the arithmetic is here, tested, so a
 * future source of their own plan prices needs no new rule.
 */
export function estimateTierUpgrade(i: {
  currentAnnualMinor: bigint | null;
  nextPlanAnnualMinor: bigint | null;
  currency?: string | null;
}): Estimate {
  const none: Estimate = {
    method: "TIER_UPGRADE_DELTA",
    estimateMinor: null,
    currency: null,
    isEstimate: true,
    label: "No price on file",
  };
  if (i.currentAnnualMinor === null || i.nextPlanAnnualMinor === null || !i.currency) return none;
  const delta = i.nextPlanAnnualMinor - i.currentAnnualMinor;
  if (delta <= 0n) return none;
  return { ...none, estimateMinor: delta, currency: i.currency, label: "Estimate" };
}
