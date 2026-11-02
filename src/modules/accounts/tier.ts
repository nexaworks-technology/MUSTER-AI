/**
 * Account tier by ARR band (ARCHITECTURE INTERP-3, thresholds in WorkspaceSettings). Lower
 * edges are inclusive. A manual override always wins; missing ARR or ARR in another currency
 * never moves an account (Rule 4, Q-12).
 */
export type Tier = "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";

export interface TierRule {
  highTouchMinArrMinor: bigint;
  midTouchMinArrMinor: bigint;
  currency: string;
}

export function deriveTier(
  arr: { minor: bigint; currency: string } | null,
  rule: TierRule,
  current: { tier: Tier; tierSource: "RULE" | "MANUAL" },
): Tier {
  if (current.tierSource === "MANUAL" || arr === null || arr.currency !== rule.currency)
    return current.tier;
  if (arr.minor >= rule.highTouchMinArrMinor) return "HIGH_TOUCH";
  if (arr.minor >= rule.midTouchMinArrMinor) return "MID_TOUCH";
  return "LONG_TAIL";
}
