import { describe, expect, it } from "vitest";
import { condition, describeCondition, templateInput } from "../schemas";
import { firstMet, type UsageData } from "../value";

/** D1 / D3: steps and value complete only on a date the measured rows prove, with those rows as evidence. */
const data = (over: Partial<UsageData> = {}): UsageData => ({
  usage: [
    { id: "u1", date: "2026-10-05", activeUsers: 5 },
    { id: "u2", date: "2026-10-06", activeUsers: 10 },
    { id: "u3", date: "2026-10-07", activeUsers: 10 },
    { id: "u4", date: "2026-10-08", activeUsers: 9 },
  ],
  featureUsage: [
    { id: "f1", featureKey: "dashboards", date: "2026-10-03", users: 2 },
    { id: "f2", featureKey: "dashboards", date: "2026-10-09", users: 1 },
    { id: "f3", featureKey: "reports", date: "2026-10-04", users: 1 },
    { id: "f4", featureKey: "sso", date: "2026-10-02", users: 0 },
  ],
  keyFeatures: ["dashboards", "reports", "data_connectors"],
  seatsPurchased: 15,
  ...over,
});
const c = (x: unknown) => condition.parse(x);

describe("firstMet", () => {
  it("a feature used on 2 different days is met on the second day, with both rows as evidence", () => {
    expect(
      firstMet(
        [c({ metric: "featureUsed", featureKey: "dashboards", minDays: 2 })],
        data(),
        "2026-10-01",
        "2026-11-02",
      ),
    ).toEqual({
      date: "2026-10-09",
      evidence: [
        { sourceType: "FeatureUsageDaily", sourceId: "f1", value: 2, date: "2026-10-03" },
        { sourceType: "FeatureUsageDaily", sourceId: "f2", value: 1, date: "2026-10-09" },
      ],
    });
  });

  it("2 key features: met when the second one is first used; a zero-user row never counts", () => {
    const r = firstMet(
      [c({ metric: "keyFeaturesUsed", min: 2 })],
      data(),
      "2026-10-01",
      "2026-11-02",
    );
    expect(r?.date).toBe("2026-10-04");
    expect(r?.evidence.map((e) => e.sourceId)).toEqual(["f1", "f3"]);
  });

  it("≥ 60% of seats active on 3 days in a row → the third such day; a missing day breaks the run", () => {
    expect(
      firstMet(
        [c({ metric: "activeSeatShare", min: 0.6, days: 3 })],
        data(),
        "2026-10-01",
        "2026-11-02",
      )?.date,
    ).toBe("2026-10-08");
    expect(
      firstMet(
        [c({ metric: "activeSeatShare", min: 0.6, days: 3 })],
        data({ usage: data().usage.filter((u) => u.id !== "u3") }),
        "2026-10-01",
        "2026-11-02",
      ),
    ).toBeNull();
  });

  it("all conditions must hold on the same day; evidence is the union", () => {
    const r = firstMet(
      [
        c({ metric: "activeUsers", min: 9, days: 2 }),
        c({ metric: "featureUsed", featureKey: "reports" }),
      ],
      data(),
      "2026-10-01",
      "2026-11-02",
    );
    expect(r?.date).toBe("2026-10-07");
    expect(r?.evidence.map((e) => e.sourceId)).toEqual(["u2", "u3", "f3"]);
  });

  it("missing data never completes anything (Rule 4): no seats on file, no rows, an empty definition", () => {
    expect(
      firstMet(
        [c({ metric: "activeSeatShare", min: 0.1 })],
        data({ seatsPurchased: null }),
        "2026-10-01",
        "2026-11-02",
      ),
    ).toBeNull();
    expect(
      firstMet(
        [c({ metric: "activeUsers", min: 1 })],
        data({ usage: [] }),
        "2026-10-01",
        "2026-11-02",
      ),
    ).toBeNull();
    expect(firstMet([], data(), "2026-10-01", "2026-11-02")).toBeNull();
  });

  it("rows before the plan started do not count", () => {
    expect(
      firstMet(
        [c({ metric: "featureUsed", featureKey: "dashboards", minDays: 2 })],
        data(),
        "2026-10-05",
        "2026-11-02",
      ),
    ).toBeNull();
  });
});

describe("template schema and plain words", () => {
  it("describes conditions the way a CSM would say them", () => {
    expect(describeCondition(c({ metric: "activeSeatShare", min: 0.6, days: 14 }))).toBe(
      "at least 60% of seats active on each of 14 weekdays in a row",
    );
    expect(
      describeCondition(c({ metric: "featureUsed", featureKey: "scheduled_reports", minDays: 3 }), {
        scheduled_reports: "Scheduled reports",
      }),
    ).toBe("Scheduled reports used on 3 different days");
    expect(describeCondition(c({ metric: "keyFeaturesUsed", min: 1 }))).toBe(
      "1 key feature of the plan used",
    );
  });

  it("refuses duplicate step keys and unknown metrics", () => {
    const step = { key: "kickoff", title: "Kickoff", ownerSide: "US", dueDay: 3 };
    expect(
      templateInput.safeParse({
        name: "T",
        targetDays: 30,
        steps: [step, step],
        valueDefinition: [],
      }).success,
    ).toBe(false);
    expect(condition.safeParse({ metric: "vibes", min: 1 }).success).toBe(false);
  });
});
