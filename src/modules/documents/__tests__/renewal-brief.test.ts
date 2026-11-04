import { describe, expect, it } from "vitest";
import {
  briefMetrics,
  RENEWAL_BRIEF_KEYS,
  CUSTOMER_SAFE_KEYS,
  type BriefFacts,
} from "../renewal-brief";

/** The Renewal Brief's locked metrics (M7 B3): pure, from facts, every one with its sources. */
const facts = (o: Partial<BriefFacts> = {}): BriefFacts => ({
  renewal: {
    id: "r1",
    contractId: "k1",
    dateText: "Dec 13, 2026",
    daysTo: 41,
    noticeDeadlineText: "Nov 13, 2026",
    confidence: 70,
    band: "HIGH",
    arrMinor: 14_200_000n,
    currency: "USD",
  },
  health: {
    snapshotId: "h1",
    band: "HEALTHY",
    overall: 88.5,
    parts: {
      adoption: 82,
      engagement: 90.25,
      support: 71,
      relationship: null,
      commercial: 93,
      sentiment: null,
    },
  },
  risks: [
    { id: "s2", title: "Ticket open 9 days: Export fails", severity: "CRITICAL" },
    { id: "s1", title: "60 of 158 seats in use", severity: "WARN" },
  ],
  goals: [
    { id: "g1", status: "ACHIEVED" },
    { id: "g2", status: "OPEN" },
    { id: "g3", status: "DROPPED" },
  ],
  expansion: {
    id: "e1",
    titles: ["52 of 40 seats in use"],
    estimateMinor: 1_080_000n,
    currency: "USD",
  },
  nextStep: { dateText: "2026-11-09" },
  ...o,
});

describe("briefMetrics", () => {
  it("produces exactly the declared keys, each with a label and at least one source unless there is no record", () => {
    const m = briefMetrics(facts());
    expect(Object.keys(m).sort()).toEqual([...RENEWAL_BRIEF_KEYS].sort());
    for (const [k, v] of Object.entries(m)) {
      expect(v.key).toBe(k);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.text.length).toBeGreaterThan(0);
    }
    for (const k of [
      "renewal.date",
      "renewal.confidence",
      "health.band",
      "risks.count",
      "goals.status",
    ])
      expect(m[k]!.sources.length).toBeGreaterThan(0);
  });

  it("reads the records' figures into text", () => {
    const m = briefMetrics(facts());
    expect(m["renewal.daysTo"]!.text).toBe("41 days");
    expect(m["renewal.confidence"]!.text).toBe("70%");
    expect(m["renewal.confidenceBand"]!.text).toBe("High");
    expect(m["renewal.arr"]!.text).toBe("$142,000.00");
    expect(m["health.overall"]!.text).toBe("88.5");
    expect(m["health.engagement"]!.text).toBe("90.3");
    expect(m["risks.count"]!.text).toBe("2 open risk signals");
    expect(m["risks.top"]!.text).toBe("Ticket open 9 days: Export fails");
    expect(m["goals.status"]!.text).toBe("1 of 2 goals achieved");
    expect(m["expansion.estimate"]!.text).toBe("Estimate: $10,800.00 ARR");
    expect(m["plan.nextStepDate"]!.text).toBe("2026-11-09");
  });

  it("missing data is said, never a number: no part score, no goals, no contract value, no estimate", () => {
    const m = briefMetrics(
      facts({
        renewal: { ...facts().renewal, arrMinor: null, currency: null, noticeDeadlineText: null },
        health: null,
        risks: [],
        goals: [],
        expansion: null,
        nextStep: null,
      }),
    );
    expect(m["health.band"]!.text).toBe("No health score on file");
    expect(m["health.adoption"]!.text).toBe("No data");
    expect(m["renewal.arr"]!.text).toBe("No contract value on file");
    expect(m["renewal.noticeDeadline"]!.text).toBe("No notice period on file");
    expect(m["risks.count"]!.text).toBe("No open risk signals");
    expect(m["goals.status"]!.text).toBe("No goals on file");
    expect(m["expansion.chance"]!.text).toBe("No open expansion opportunity");
    expect(m["expansion.estimate"]!.text).toBe("No estimate on file");
    expect(m["plan.nextStepDate"]!.text).toBe("No next step set");
  });

  it("promise status says tracking is not connected yet: no promise data is invented", () => {
    expect(briefMetrics(facts())["promises.status"]!.text).toMatch(/not connected yet/);
  });

  it("money metrics are flagged money, and only the renewal date is customer-safe", () => {
    const m = briefMetrics(facts());
    expect(
      Object.values(m)
        .filter((x) => x.money)
        .map((x) => x.key)
        .sort(),
    ).toEqual(["expansion.estimate", "renewal.arr"]);
    expect(CUSTOMER_SAFE_KEYS).toEqual(["renewal.date"]);
  });

  it("is deterministic", () => {
    expect(briefMetrics(facts())).toEqual(briefMetrics(facts()));
  });
});
