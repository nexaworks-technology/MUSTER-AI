import { describe, expect, it } from "vitest";
import {
  computeQbrMetrics,
  isValidPeriodLabel,
  validateNarrativeText,
  validatePeriodLabel,
} from "../metrics";

describe("Slice 7: QBR metrics engine and placeholder validation", () => {
  describe("Period label closed allowlist", () => {
    it("admits valid quarter labels and ISO dates", () => {
      expect(isValidPeriodLabel("Q1 2026")).toBe(true);
      expect(isValidPeriodLabel("Q2 2026")).toBe(true);
      expect(isValidPeriodLabel("Q3 2026")).toBe(true);
      expect(isValidPeriodLabel("Q4 2026")).toBe(true);
      expect(isValidPeriodLabel("2026-11-05")).toBe(true);
      expect(validatePeriodLabel("Q3 2026")).toEqual({ valid: true, value: "Q3 2026" });
    });

    it("refuses quantities, percentages, and currencies", () => {
      expect(isValidPeriodLabel("12 seats")).toBe(false);
      expect(isValidPeriodLabel("42")).toBe(false);
      expect(isValidPeriodLabel("50%")).toBe(false);
      expect(isValidPeriodLabel("$10,000")).toBe(false);
      expect(isValidPeriodLabel("£500")).toBe(false);
      expect(isValidPeriodLabel("100k USD")).toBe(false);
      expect(isValidPeriodLabel("€25,000")).toBe(false);
      expect(isValidPeriodLabel("random text")).toBe(false);

      expect(validatePeriodLabel("$10,000")).toEqual({
        valid: false,
        error: expect.stringMatching(/closed allowlist|currency|quantity/i),
      });
    });
  });

  describe("Narrative text validation (Rule: edits text only, locked metric panel holds numbers)", () => {
    it("admits clean narrative prose without raw metric alterations", () => {
      const clean =
        "The team had strong engagement throughout the quarter with multiple productive meetings.";
      const res = validateNarrativeText(clean);
      expect(res.valid).toBe(true);
      expect(res.violations).toHaveLength(0);
    });

    it("detects and flags raw unapproved currency and quantity injections", () => {
      const tainted1 = "We saved the customer $50,000 in software costs.";
      const res1 = validateNarrativeText(tainted1);
      expect(res1.valid).toBe(false);
      expect(res1.violations).toContainEqual(expect.stringMatching(/currency/i));

      const tainted2 = "ARR increased to £120,000 with 150 new seats.";
      const res2 = validateNarrativeText(tainted2);
      expect(res2.valid).toBe(false);
      expect(res2.violations).toContainEqual(expect.stringMatching(/currency/i));
    });
  });

  describe("Pure metrics computation", () => {
    it("computes metrics with honest nulls and labels when data is missing", () => {
      const metrics = computeQbrMetrics({
        account: { id: "a1", name: "Acme", arrMinor: 10000000n, arrCurrency: "USD" },
        healthSnapshot: null,
        contract: null,
        usage: [],
        promises: [],
        tickets: [],
        canViewRevenue: true,
      });

      expect(metrics.health.score).toBeNull();
      expect(metrics.health.label).toMatch(/no health data/i);
      expect(metrics.contract.renewalDate).toBeNull();
      expect(metrics.contract.label).toMatch(/no active contract/i);
      expect(metrics.support.ticketCount).toBe(0);
      expect(metrics.promises.total).toBe(0);
    });

    it("computes honest metrics when data is present", () => {
      const metrics = computeQbrMetrics({
        account: { id: "a1", name: "Acme", arrMinor: 5000000n, arrCurrency: "USD" },
        healthSnapshot: {
          overall: 82,
          riskLevel: "LOW",
          adoption: 85,
          engagement: 78,
          support: 90,
          relationship: 80,
          commercial: 85,
          sentiment: 75,
        },
        contract: {
          seatsPurchased: 50,
          startDate: new Date("2026-01-01"),
          renewalDate: new Date("2027-01-01"),
        },
        usage: [
          { date: new Date("2026-10-01"), seatsUsed: 42 },
          { date: new Date("2026-10-02"), seatsUsed: 45 },
        ],
        promises: [
          { status: "KEPT" },
          { status: "OPEN" },
        ],
        tickets: [{ id: "t1" }, { id: "t2" }],
        canViewRevenue: true,
      });

      expect(metrics.health.score).toBe(82);
      expect(metrics.health.band).toBe("GOOD");
      expect(metrics.contract.seatsPurchased).toBe(50);
      expect(metrics.usage.latestSeatsUsed).toBe(45);
      expect(metrics.usage.utilizationPercent).toBe(90);
      expect(metrics.promises.kept).toBe(1);
      expect(metrics.promises.open).toBe(1);
      expect(metrics.support.ticketCount).toBe(2);
      expect(metrics.revenue.arrFormatted).toBe("$50,000");
    });

    it("redacts revenue when canViewRevenue is false", () => {
      const metrics = computeQbrMetrics({
        account: { id: "a1", name: "Acme", arrMinor: 5000000n, arrCurrency: "USD" },
        healthSnapshot: {
          overall: 82,
          riskLevel: "LOW",
          adoption: 85,
          engagement: 78,
          support: 90,
          relationship: 80,
          commercial: 85,
          sentiment: 75,
        },
        contract: null,
        usage: [],
        promises: [],
        tickets: [],
        canViewRevenue: false,
      });

      expect(metrics.revenue.arrFormatted).toBeNull();
      expect(metrics.revenue.label).toMatch(/revenue access required/i);
    });
  });
});
