import { describe, expect, it } from "vitest";
import { businessNow, realClock } from "..";

/**
 * The business clock (Q-49, D-81): "now" and "today" for scoring, signals, Today, escalation,
 * outcomes and sends. Real time unless a test harness sets BOTH ALLOW_FAKE_CLOCK=true and
 * APP_FAKE_NOW, and never in production. These are the production-safety proofs.
 */
const REAL = new Date("2031-05-05T05:05:05Z");
const real = () => REAL;
const FAKE = "2026-11-02T17:00:00Z";

describe("businessNow", () => {
  it("ignores APP_FAKE_NOW when ALLOW_FAKE_CLOCK is unset: real time", () => {
    expect(businessNow({ APP_FAKE_NOW: FAKE }, real)).toEqual(REAL);
  });

  it('ignores ALLOW_FAKE_CLOCK alone, or any value other than "true"', () => {
    expect(businessNow({ ALLOW_FAKE_CLOCK: "true" }, real)).toEqual(REAL);
    for (const v of ["1", "yes", "TRUE", ""])
      expect(businessNow({ ALLOW_FAKE_CLOCK: v, APP_FAKE_NOW: FAKE }, real)).toEqual(REAL);
  });

  it("ignores both in production, whatever they say", () => {
    expect(
      businessNow({ NODE_ENV: "production", ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: FAKE }, real),
    ).toEqual(REAL);
  });

  it("returns the fake instant when both are set outside production", () => {
    expect(businessNow({ ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: FAKE }, real)).toEqual(
      new Date(FAKE),
    );
    expect(
      businessNow({ NODE_ENV: "test", ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: FAKE }, real),
    ).toEqual(new Date(FAKE));
  });

  it("refuses an APP_FAKE_NOW that is not an ISO 8601 instant, naming the variable only", () => {
    expect(() =>
      businessNow({ ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: "next tuesday" }, real),
    ).toThrow(/APP_FAKE_NOW/);
    expect(() =>
      businessNow({ ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: "2026-11-02" }, real),
    ).toThrow(/APP_FAKE_NOW/);
  });

  it("the real clock is never faked", () => {
    const before = Date.now();
    const t = realClock().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
