import type { AccountBundle } from "@/modules/health/service";
import { RULE_BY_KEY, type RuleKey } from "./catalog";
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
 * Pinned renewal back-test risk-rule allowlist (V1) (D-145, REVIEW-2026-11-05 S1).
 *
 * The renewal-confidence back-test (D-118, D-120) was pre-registered and calibrated on exactly
 * these 12 rules. To prevent new rules added in M10+ from silently altering historical calibration,
 * this set is pinned by construction to this explicit allowlist rather than dynamically filtered.
 * Whether any new signal rule belongs in the factor model requires a fresh as-of back-test under
 * D-118 and must be recorded as its own DECISIONS.md entry, never a silent list edit.
 */
export const RENEWAL_BACKTEST_RULES_V1: readonly RuleKey[] = [
  "usage_drop_vs_normal",
  "key_feature_stopped",
  "power_user_quiet",
  "seats_unused",
  "ticket_open_too_long",
  "ticket_escalated",
  "contact_bounced_or_left",
  "onboarding_stall",
  "onboarding_step_overdue_customer",
  "onboarding_no_activity",
  "onboarding_key_feature_unused",
  "onboarding_ttv_late",
] as const;

export const RENEWAL_RISK_RULE_KEYS: readonly RuleKey[] = RENEWAL_BACKTEST_RULES_V1;

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
