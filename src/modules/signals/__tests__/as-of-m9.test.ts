import { describe, expect, it } from "vitest";
import { RULES } from "../rules/catalog";
import {
  RENEWAL_BACKTEST_RULES_V1,
  RENEWAL_RISK_RULE_KEYS,
  RESTATES_OTHER_FACTORS,
} from "../rules/as-of";

/**
 * Pinned M7/M8 renewal back-test risk rules (D-118, D-120, D-145).
 */
const CALIBRATED_M7_RULES = [
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
];

/**
 * Rules in the catalogue with polarity === "RISK" that are explicitly excluded from the
 * renewal back-test (V1) by pre-existing recorded architectural decisions:
 * - RESTATES_OTHER_FACTORS (D-119): already represented in other factors (money/invoices)
 * - OUTSIDE rules (D-119): outside events
 * - Dormant rules (D-61): data source not yet active
 * - M9 rules (D-145): text, promise, and people signal rules added in M9
 */
const KNOWN_DECIDED_EXCLUSIONS = new Set<string>([
  ...RESTATES_OTHER_FACTORS,
  "outside_event",
  "no_meeting_in_x_days",
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
  "champion_silent",
  "champion_role_change",
  "new_decision_maker",
  "email_engagement_stops",
]);

describe("the as-of risk rules the renewal back-test reads", () => {
  it("are pinned by construction to RENEWAL_BACKTEST_RULES_V1 matching the calibrated M7 set", () => {
    expect(RENEWAL_RISK_RULE_KEYS).toBe(RENEWAL_BACKTEST_RULES_V1);
    expect([...RENEWAL_BACKTEST_RULES_V1].sort()).toEqual([...CALIBRATED_M7_RULES].sort());
  });

  it("fails when a new RISK-category rule joins the catalogue without being added to the allowlist", () => {
    const allowlistSet = new Set<string>(RENEWAL_BACKTEST_RULES_V1);
    const riskRules = RULES.filter((r) => r.polarity === "RISK");

    const unassignedRules = riskRules.filter(
      (r) => !allowlistSet.has(r.key) && !KNOWN_DECIDED_EXCLUSIONS.has(r.key),
    );

    if (unassignedRules.length > 0) {
      const keys = unassignedRules.map((r) => `"${r.key}"`).join(", ");
      throw new Error(
        `New RISK-category rule(s) [${keys}] joined the catalogue without being added to RENEWAL_BACKTEST_RULES_V1 or an explicit DECISIONS entry.\n` +
          `A human must decide whether the new rule belongs in the back-test, and that decision is a DECISIONS entry, never a silent list edit.`,
      );
    }

    expect(unassignedRules).toHaveLength(0);
  });
});
