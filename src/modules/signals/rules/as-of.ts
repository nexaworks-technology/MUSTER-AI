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

/**
 * M9's rules (text, promise and people): not part of the as-of risk signals. The renewal-confidence
 * back-test (D-118, D-120) was pre-registered and measured on the M3–M8 rules; adding rules here
 * would silently change the factor model's recorded numbers, which is a silent wiring of a new
 * factor (M9 rule 6). Whether the new signals belong in the factor model is a fresh as-of back-test
 * under the same pre-registered rule, reported as its own decision, never a side effect.
 */
export const M9_RULES_OUTSIDE_THE_BACKTEST = new Set<RuleKey>([
  "promise_late",
  "promise_no_owner",
  "competitor_mentioned",
  "budget_concern",
  "cancel_language",
  "export_language",
  "complaint_repeated",
  "repeat_problem",
  "angry_sentiment",
  "renewal_concern",
  "no_reply_important_followup",
  "goal_stated",
  "champion_silent",
  "champion_role_change",
  "new_decision_maker",
  "email_engagement_stops",
]);

export const RENEWAL_RISK_RULE_KEYS: readonly RuleKey[] = RULES.filter(
  (r) =>
    r.polarity === "RISK" &&
    r.category !== "OUTSIDE" &&
    !r.dormantReason &&
    !RESTATES_OTHER_FACTORS.has(r.key) &&
    !M9_RULES_OUTSIDE_THE_BACKTEST.has(r.key),
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
