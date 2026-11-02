import { describe, expect, it } from "vitest";
import { deriveTier } from "../tier";

const rule = { highTouchMinArrMinor: 5_000_000n, midTouchMinArrMinor: 1_000_000n, currency: "USD" };
const usd = (dollars: number) => ({ minor: BigInt(dollars * 100), currency: "USD" });

describe("tier rule (INTERP-3)", () => {
  it("bands by ARR with inclusive lower edges: exactly $10k is mid-touch, exactly $50k is high-touch", () => {
    expect(deriveTier(usd(9_999), rule, { tier: "MID_TOUCH", tierSource: "RULE" })).toBe(
      "LONG_TAIL",
    );
    expect(deriveTier(usd(10_000), rule, { tier: "LONG_TAIL", tierSource: "RULE" })).toBe(
      "MID_TOUCH",
    );
    expect(deriveTier(usd(49_999), rule, { tier: "HIGH_TOUCH", tierSource: "RULE" })).toBe(
      "MID_TOUCH",
    );
    expect(deriveTier(usd(50_000), rule, { tier: "MID_TOUCH", tierSource: "RULE" })).toBe(
      "HIGH_TOUCH",
    );
  });

  it("a manual override survives re-derivation", () => {
    expect(deriveTier(usd(500), rule, { tier: "HIGH_TOUCH", tierSource: "MANUAL" })).toBe(
      "HIGH_TOUCH",
    );
  });

  it("no ARR on file never moves an account (missing data never moves it down, Rule 4)", () => {
    expect(deriveTier(null, rule, { tier: "HIGH_TOUCH", tierSource: "RULE" })).toBe("HIGH_TOUCH");
  });

  it("ARR in another currency is not compared (no FX, Q-12)", () => {
    expect(
      deriveTier({ minor: 100n, currency: "EUR" }, rule, {
        tier: "HIGH_TOUCH",
        tierSource: "RULE",
      }),
    ).toBe("HIGH_TOUCH");
  });
});
