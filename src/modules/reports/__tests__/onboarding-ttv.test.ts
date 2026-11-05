import { describe, expect, it } from "vitest";
import { onboardingTtvReport, type TtvReportInput } from "../onboarding-ttv";
import { everyFigureIsProven, fig } from "./helpers";

const input: TtvReportInput = {
  completed: [
    {
      planId: "p1",
      accountId: "a1",
      startDate: "2026-09-01",
      valueReachedAt: "2026-09-11",
      targetValueDate: "2026-09-15",
    }, // 10d on time
    {
      planId: "p2",
      accountId: "a2",
      startDate: "2026-09-01",
      valueReachedAt: "2026-09-21",
      targetValueDate: "2026-09-15",
    }, // 20d late
    {
      planId: "p3",
      accountId: "a3",
      startDate: "2026-09-10",
      valueReachedAt: "2026-09-30",
      targetValueDate: "2026-09-30",
    }, // 20d on time
  ],
  open: [
    {
      planId: "p4",
      accountId: "a4",
      ttv: {
        state: "NOT_REACHED",
        days: 40,
        verdict: "LATE",
        reason: "Day 40",
        ownTargetDays: 30,
        cohort: null,
        sources: [],
      },
    },
    {
      planId: "p5",
      accountId: "a5",
      ttv: {
        state: "NOT_REACHED",
        days: 5,
        verdict: "IN_PROGRESS",
        reason: "Day 5",
        ownTargetDays: 30,
        cohort: null,
        sources: [],
      },
    },
    {
      planId: "p6",
      accountId: "a6",
      ttv: {
        state: "NO_DEFINITION",
        days: null,
        verdict: null,
        reason: "No value definition for this plan",
        ownTargetDays: 30,
        cohort: null,
        sources: [],
      },
    },
  ],
  query: "",
};

describe("onboarding time to value", () => {
  const r = onboardingTtvReport(input);

  it("gives the median days to value of plans that reached it in the period", () => {
    const f = fig(r, "Median days to value");
    expect(f.value).toBe(20);
    expect(f.unit).toBe("days");
    expect(f.sources).toMatchObject({ type: "OnboardingPlan", ids: ["p1", "p2", "p3"] });
  });

  it("counts plans that reached value within their own target", () => {
    expect(fig(r, "Reached value by the plan's target").sources.ids).toEqual(["p1", "p3"]);
    expect(fig(r, "Share that reached value by target").value).toBe(67);
  });

  it("lists open plans that are late and those with no value definition apart", () => {
    expect(fig(r, "Open plans running late").sources.ids).toEqual(["p4"]);
    expect(fig(r, "Open plans with no value definition").sources.ids).toEqual(["p6"]);
  });

  it("no completed plan means no median, said plainly", () => {
    const e = onboardingTtvReport({ ...input, completed: [] });
    const f = fig(e, "Median days to value");
    expect(f.value).toBeNull();
    expect(f.reason).toMatch(/No onboarding plan reached value/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
