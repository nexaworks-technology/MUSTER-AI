import { describe, expect, it } from "vitest";
import { briefMetrics, type BriefFacts } from "../renewal-brief";

/** M9 B3: the renewal brief's promise metric for NEW briefs. Existing briefs keep their locked metrics. */
const facts = (promises?: BriefFacts["promises"]): BriefFacts => ({
  renewal: { id: "r1", contractId: "k1", dateText: "Dec 13, 2026", daysTo: 41, noticeDeadlineText: "Nov 13, 2026", confidence: 70, band: "HIGH", arrMinor: null, currency: null },
  health: null,
  risks: [],
  goals: [],
  expansion: null,
  ...(promises ? { promises } : {}),
});

describe("promises.status", () => {
  it("counts our promises by status, with every promise as a source", () => {
    const m = briefMetrics(facts([
      { id: "p1", party: "US", status: "LATE" },
      { id: "p2", party: "US", status: "BROKEN" },
      { id: "p3", party: "US", status: "OPEN" },
      { id: "p4", party: "US", status: "KEPT" },
      { id: "p5", party: "CUSTOMER", status: "LATE" },
    ]))["promises.status"]!;
    expect(m.text).toBe("4 promises made: 2 late, 1 open, 1 kept");
    expect(m.value).toBe(4);
    expect(m.sources).toEqual([1, 2, 3, 4].map((n) => ({ sourceType: "Promise", sourceId: `p${n}` })));
  });
  it("one promise reads in the singular", () => {
    expect(briefMetrics(facts([{ id: "p1", party: "US", status: "LATE" }]))["promises.status"]!.text).toBe("1 promise made: 1 late, 0 open, 0 kept");
  });
  it("no promise on file says so, without a source (nothing invented)", () => {
    for (const f of [facts([]), facts()]) {
      const m = briefMetrics(f)["promises.status"]!;
      expect(m.text).toBe("No promises on file");
      expect(m.value).toBeNull();
      expect(m.sources).toEqual([]);
    }
  });
});
