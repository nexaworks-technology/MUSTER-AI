import { describe, expect, it } from "vitest";
import { materiallyWorse } from "../rules";

/** D-53: a false alarm reopens only when materially worse than when it was marked. */
const w = (severity: "INFO" | "WARN" | "CRITICAL", values: Record<string, unknown>) => ({
  severity,
  values,
});

describe("materially worse (D-53)", () => {
  it("a higher severity always counts", () => {
    expect(materiallyWorse("ticket_escalated", w("WARN", {}), w("CRITICAL", {}), {})).toBe(true);
    expect(materiallyWorse("ticket_escalated", w("WARN", {}), w("WARN", {}), {})).toBe(false);
  });

  it("usage: the ratio must fall at least 0.15 further", () => {
    const was = w("WARN", { ratio: 0.65 });
    expect(materiallyWorse("usage_drop_vs_normal", was, w("WARN", { ratio: 0.51 }), {})).toBe(
      false,
    );
    expect(materiallyWorse("usage_drop_vs_normal", was, w("WARN", { ratio: 0.5 }), {})).toBe(true);
  });

  it("seats: 10 percentage points in the worse direction", () => {
    expect(
      materiallyWorse(
        "seats_near_limit",
        w("INFO", { ratio: 0.9 }),
        w("INFO", { ratio: 0.95 }),
        {},
      ),
    ).toBe(false);
    expect(
      materiallyWorse("seats_near_limit", w("INFO", { ratio: 0.9 }), w("INFO", { ratio: 1 }), {}),
    ).toBe(true);
    expect(
      materiallyWorse("seats_unused", w("WARN", { ratio: 0.4 }), w("WARN", { ratio: 0.3 }), {}),
    ).toBe(true);
    expect(
      materiallyWorse("seats_unused", w("WARN", { ratio: 0.4 }), w("WARN", { ratio: 0.35 }), {}),
    ).toBe(false);
  });

  it("payments: one more failure; late invoices: 30 more days", () => {
    expect(
      materiallyWorse("payment_failed", w("WARN", { failures: 1 }), w("WARN", { failures: 1 }), {}),
    ).toBe(false);
    expect(
      materiallyWorse(
        "payment_failed",
        w("WARN", { failures: 1 }),
        w("CRITICAL", { failures: 2 }),
        {},
      ),
    ).toBe(true);
    expect(
      materiallyWorse("invoice_late", w("WARN", { daysLate: 10 }), w("WARN", { daysLate: 39 }), {}),
    ).toBe(false);
    expect(
      materiallyWorse("invoice_late", w("WARN", { daysLate: 10 }), w("WARN", { daysLate: 40 }), {}),
    ).toBe(true);
  });

  it("uses the workspace's own threshold when it was edited", () => {
    const was = w("WARN", { ratio: 0.65 });
    const p = {
      materialDrop: 0.05,
      warnRatio: 0.7,
      criticalRatio: 0.5,
      clearRatio: 0.8,
      minNormalUsers: 3,
    };
    expect(materiallyWorse("usage_drop_vs_normal", was, w("WARN", { ratio: 0.6 }), p)).toBe(true);
  });

  it("yes/no rules reopen on severity only", () => {
    for (const k of [
      "key_feature_stopped",
      "power_user_quiet",
      "renewal_window_90",
      "contact_bounced_or_left",
    ] as const)
      expect(materiallyWorse(k, w("WARN", {}), w("WARN", {}), {})).toBe(false);
  });
});
