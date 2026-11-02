/**
 * Pricing structure only (QUESTIONS Q-02). The founder has not set prices: there are no
 * amounts here, nothing renders a price, and `isFinal` stays false until a decision is recorded.
 */
export type PricingDimension = "perCsmSeat" | "perAccountBand";

export interface PlanStructure {
  id: string;
  label: string;
  dimension: PricingDimension;
  /** Limits a plan could enforce later (M12 if ever enforced); null = undecided. */
  limits: { csmSeats: number | null; accounts: number | null };
}

export const PRICING = {
  isFinal: false,
  principle: "Simple, published, no implementation fee (spec §10.2)",
  plans: [] as PlanStructure[],
} as const;
