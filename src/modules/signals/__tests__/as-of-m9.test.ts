import { describe, expect, it } from "vitest";
import { RULES } from "../rules/catalog";
import { M9_RULES_OUTSIDE_THE_BACKTEST, RENEWAL_RISK_RULE_KEYS } from "../rules/as-of";

/**
 * M9 rule 6: the pre-registered renewal back-test (D-118, D-120) is measured on the M3–M8 risk
 * rules. M9's new rules must not enter it silently; the set it reads is pinned here.
 */
const M8_BACKTEST_RULES = [
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

describe("the as-of risk rules the renewal back-test reads", () => {
  it("are exactly the M8 set: no M9 rule is in it", () => {
    expect([...RENEWAL_RISK_RULE_KEYS].sort()).toEqual([...M8_BACKTEST_RULES].sort());
    for (const k of RENEWAL_RISK_RULE_KEYS)
      expect(M9_RULES_OUTSIDE_THE_BACKTEST.has(k)).toBe(false);
  });

  it("every M9 rule in the catalogue is named in the excluded set (a new M9 rule cannot slip in)", () => {
    const m9 = RULES.filter((r) => M9_RULES_OUTSIDE_THE_BACKTEST.has(r.key));
    expect(m9).toHaveLength(M9_RULES_OUTSIDE_THE_BACKTEST.size);
    expect(m9.length).toBe(16);
  });
});
