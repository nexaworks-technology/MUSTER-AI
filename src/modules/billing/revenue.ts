/**
 * Rule-derived ARR movement (ARCHITECTURE §3.2 RevenueEvent, computedBy RULE). Pure functions:
 * same contracts in, same events out. Money is never inferred: contracts without a value create
 * no event, amounts in different currencies are never compared (Q-12), and churn needs a
 * contract explicitly ENDED or CANCELLED — a missing renewal record is not a lost customer.
 */
export interface ContractFacts {
  id: string;
  startDate: Date;
  endDate: Date | null;
  valueMinor: bigint | null;
  currency: string;
  status: "ACTIVE" | "ENDED" | "CANCELLED";
}

export interface DerivedRevenueEvent {
  type: "NEW" | "EXPANSION" | "CONTRACTION" | "CHURN" | "REACTIVATION";
  deltaArrMinor: bigint;
  currency: string;
  effectiveDate: Date;
  sourceType: "Contract";
  sourceId: string;
}

/** A gap longer than this between contracts means the customer left and came back. */
export const RENEWAL_GRACE_DAYS = 31;
const DAY = 86_400_000;

const byStart = (a: ContractFacts, b: ContractFacts) =>
  a.startDate.getTime() - b.startDate.getTime() || a.id.localeCompare(b.id);

export function deriveRevenueEvents(
  contracts: readonly ContractFacts[],
  asOf: Date,
): DerivedRevenueEvent[] {
  const valued = contracts
    .filter((c) => c.valueMinor !== null && c.startDate <= asOf)
    .sort(byStart);
  const events: DerivedRevenueEvent[] = [];
  const ev = (type: DerivedRevenueEvent["type"], c: ContractFacts, delta: bigint, at: Date) =>
    events.push({
      type,
      deltaArrMinor: delta,
      currency: c.currency,
      effectiveDate: at,
      sourceType: "Contract",
      sourceId: c.id,
    });

  let prev: ContractFacts | null = null;
  for (const c of valued) {
    const value = c.valueMinor!;
    if (!prev) {
      ev("NEW", c, value, c.startDate);
    } else if (prev.currency !== c.currency) {
      // Different currencies cannot be compared without FX data; record no movement.
    } else if (
      prev.endDate &&
      c.startDate.getTime() - prev.endDate.getTime() > RENEWAL_GRACE_DAYS * DAY
    ) {
      ev("CHURN", prev, -prev.valueMinor!, prev.endDate);
      ev("REACTIVATION", c, value, c.startDate);
    } else {
      const diff = value - prev.valueMinor!;
      if (diff > 0n) ev("EXPANSION", c, diff, c.startDate);
      if (diff < 0n) ev("CONTRACTION", c, diff, c.startDate);
    }
    prev = c;
  }
  if (prev && prev.status !== "ACTIVE" && prev.endDate && prev.endDate <= asOf) {
    ev("CHURN", prev, -prev.valueMinor!, prev.endDate);
  }
  return events;
}

/**
 * The contract in force on `asOf`: the latest-starting ACTIVE contract that has started. A past
 * end date alone does not end it — only an explicit ENDED/CANCELLED status does (Rule 4), so a
 * renewal that simply wasn't recorded never shows up as "no contract".
 */
export function currentContract<T extends ContractFacts>(
  contracts: readonly T[],
  asOf: Date,
): T | null {
  const inForce = contracts.filter((c) => c.status === "ACTIVE" && c.startDate <= asOf);
  return inForce.sort(byStart).at(-1) ?? null;
}
