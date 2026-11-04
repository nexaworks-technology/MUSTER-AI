import type { AccountBundle } from "@/modules/health/service";
import { RULES, RULE_BY_KEY, type RuleKey } from "./catalog";
import { evaluateRule, type Evidence, type Severity } from "./index";

/**
 * The risk signals an account's records would have raised on the bundle's date (M7 back-test):
 * every enabled-by-default RISK rule evaluated at its default thresholds, with no history of
 * open episodes (so fire/clear hysteresis is not applied: a rule counts when it fires). Used where
 * stored Signal rows for a past date do not exist. The rules that restate other factors (renewal
 * windows, payment and invoice signals) are left out so nothing is counted twice.
 */
const RESTATES_OTHER_FACTORS = new Set<RuleKey>([
  "renewal_window_90",
  "renewal_window_60",
  "renewal_window_30",
  "payment_failed",
  "invoice_late",
]);

export const RENEWAL_RISK_RULE_KEYS: readonly RuleKey[] = RULES.filter(
  (r) =>
    r.polarity === "RISK" &&
    r.category !== "OUTSIDE" &&
    !r.dormantReason &&
    !RESTATES_OTHER_FACTORS.has(r.key),
).map((r) => r.key);

export interface AsOfRiskSignal {
  key: RuleKey;
  severity: Exclude<Severity, "INFO">;
  title: string;
  evidence: Evidence[];
}

export function riskSignalsAsOf(bundle: AccountBundle): AsOfRiskSignal[] {
  const signalBundle = { ...bundle, invoiceFailureCounts: {}, meetings: null, onboarding: null };
  return RENEWAL_RISK_RULE_KEYS.flatMap((key) =>
    evaluateRule(key, signalBundle, undefined).flatMap((c) =>
      c.severity === "INFO"
        ? []
        : [{ key, severity: c.severity, title: c.title, evidence: c.evidence }],
    ),
  );
}

export const RISK_RULE_LABEL = (key: string) => RULE_BY_KEY.get(key as RuleKey)?.label ?? key;
export { RESTATES_OTHER_FACTORS };
