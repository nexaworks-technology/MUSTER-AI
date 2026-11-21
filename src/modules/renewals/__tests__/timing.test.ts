import { describe, expect, it } from "vitest";
import { renewalTiming } from "../timing";

describe("renewalTiming", () => {
  it("says overdue, never a negative count", () => {
    expect(renewalTiming(-12)).toBe("overdue by 12 days");
    expect(renewalTiming(-1)).toBe("overdue by 1 day");
  });
  it("today and the future", () => {
    expect(renewalTiming(0)).toBe("due today");
    expect(renewalTiming(1)).toBe("in 1 day");
    expect(renewalTiming(28)).toBe("in 28 days");
  });
});
