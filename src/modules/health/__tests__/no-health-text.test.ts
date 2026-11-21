import { describe, expect, it } from "vitest";
import { noHealthText } from "../service";

/** DEMO-WALKTHROUGH FAIL 17: a Lost account's Health tab promised a score that never comes. */
describe("Health tab with no snapshot", () => {
  it("a Lost account says Lost, not scored, with the date", () => {
    expect(
      noHealthText({ lifecycleStage: "LOST", churnedAt: new Date("2026-10-12T00:00:00Z") }),
    ).toBe("Lost, not scored (lost Oct 12, 2026). Health is only calculated for active customers.");
    expect(noHealthText({ lifecycleStage: "LOST", churnedAt: null })).toMatch(
      /^Lost, not scored\. /,
    );
  });
  it("an active account is told when it will be calculated", () => {
    expect(noHealthText({ lifecycleStage: "ADOPTING", churnedAt: null })).toMatch(/every night/);
  });
});
