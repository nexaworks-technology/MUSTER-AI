import { daysBetween, type CalendarDate } from "@/lib/dates";
import { percentile } from "@/modules/health/service";
import type { TtvResult } from "@/modules/onboarding/service";
import { count, measure, missing, percent, withQuery } from "./figures";
import type { ReportContent } from "./types";

/**
 * Onboarding time to value (spec §6G3). Plans that reached value in the period contribute their
 * days from start to value (the same days `onboarding/facts.ts` uses for peers). Open plans use
 * `timeToValue()`'s own verdict (carried in as `ttv`), so "late" here is the same "late" the
 * Onboarding screen shows.
 */
export interface TtvReportInput {
  completed: Array<{
    planId: string;
    accountId: string;
    startDate: CalendarDate;
    valueReachedAt: CalendarDate;
    targetValueDate: CalendarDate;
  }>;
  open: Array<{ planId: string; accountId: string; ttv: TtvResult | null }>;
  query: string;
}

export function onboardingTtvReport(i: TtvReportInput): ReportContent {
  const plan = (p: { planId: string; accountId: string }) => ({
    id: p.planId,
    accountId: p.accountId,
  });
  const days = i.completed.map((p) => daysBetween(p.startDate, p.valueReachedAt));
  const median = days.length ? Math.round(percentile(days, 0.5)!) : null;
  const byTarget = i.completed.filter((p) => p.valueReachedAt <= p.targetValueDate);
  const none = "No onboarding plan reached value in this period.";
  const href = withQuery("/onboarding", i.query);

  const late = i.open.filter((p) => p.ttv?.state === "NOT_REACHED" && p.ttv.verdict === "LATE");
  const noDef = i.open.filter((p) => !p.ttv || p.ttv.state === "NO_DEFINITION");

  return {
    notes: [],
    sections: [
      {
        title: "Plans that reached value in the period",
        note: "Days from the plan's start to the first day every value condition held.",
        figures: [
          measure(
            "Median days to value",
            "days",
            median,
            "OnboardingPlan",
            i.completed.map(plan),
            none,
          ),
          i.completed.length
            ? count("Reached value by the plan's target", "OnboardingPlan", byTarget.map(plan))
            : missing("Reached value by the plan's target", "count", "OnboardingPlan", none),
          percent(
            "Share that reached value by target",
            "OnboardingPlan",
            byTarget.map(plan),
            i.completed.map(plan),
            none,
          ),
        ],
      },
      {
        title: "Plans still open",
        figures: [
          count("Open plans running late", "OnboardingPlan", late.map(plan), href),
          count("Open plans with no value definition", "OnboardingPlan", noDef.map(plan), href),
          count("Open plans in total", "OnboardingPlan", i.open.map(plan), href),
        ],
      },
    ],
  };
}
