import { daysBetween, type CalendarDate } from "@/lib/dates";
import { chooseCohort, percentile, type CohortAttrs } from "@/modules/health/service";

/**
 * Time to value (spec §6G3, M6 rule 5, D3), deterministic. TTV = days from the plan's start to
 * the first business date every value condition held. It is compared first with the plan's own
 * target (the template's target day), then with the account's cohort: the time to value of
 * completed plans among "accounts like it", chosen by M3's cohort rule (chooseCohort: the finest
 * group with at least minPeers, falling back to tier). The fallback and the peer count are said in
 * the reason. It is a measurement: nothing here touches health scores.
 */
/** Proof for a figure: one record, or a range of an account's daily rows (signal Evidence shape). */
export interface Source {
  sourceType: string;
  sourceId?: string;
  accountId?: string;
  from?: CalendarDate;
  to?: CalendarDate;
  value: number | string | null;
  date: CalendarDate | null;
}

export interface TtvPeer extends CohortAttrs {
  /** Days to value of that account's completed plan. */
  ttvDays: number;
  planId: string;
}

export interface TtvInput {
  me: CohortAttrs;
  asOf: CalendarDate;
  startDate: CalendarDate;
  targetDays: number;
  hasValueDefinition: boolean;
  valueReachedAt: CalendarDate | null;
  valueEvidence: Source[];
  peers: TtvPeer[];
  minPeers: number;
}

export interface TtvCohort {
  key: string;
  label: string;
  size: number;
  medianDays: number;
  p75Days: number;
  fellBack: boolean;
}

export interface TtvResult {
  state: "NO_DEFINITION" | "REACHED" | "NOT_REACHED";
  /** Days to value (reached) or days so far (not reached); null without a definition. */
  days: number | null;
  /** ON_TIME / LATE when reached; IN_PROGRESS / LATE when not. */
  verdict: "ON_TIME" | "LATE" | "IN_PROGRESS" | null;
  reason: string;
  ownTargetDays: number;
  cohort: TtvCohort | null;
  sources: Source[];
}

const round = (n: number) => Math.round(n);

export function timeToValue(input: TtvInput): TtvResult | null {
  if (!input.hasValueDefinition)
    return {
      state: "NO_DEFINITION",
      days: null,
      verdict: null,
      reason: "No value definition for this plan",
      cohort: null,
      ownTargetDays: input.targetDays,
      sources: [],
    };
  const reached = input.valueReachedAt !== null;
  const days = daysBetween(input.startDate, input.valueReachedAt ?? input.asOf);
  const choice = chooseCohort(input.me, input.peers, input.minPeers);
  const ttvs = choice.members.map((p) => p.ttvDays);
  const cohort: TtvCohort | null = ttvs.length
    ? {
        key: choice.key,
        label: choice.label,
        size: ttvs.length,
        medianDays: round(percentile(ttvs, 0.5)!),
        p75Days: round(percentile(ttvs, 0.75)!),
        fellBack: choice.fellBack,
      }
    : null;
  const limit = cohort ? cohort.p75Days : input.targetDays;
  const verdict = reached
    ? days <= limit
      ? "ON_TIME"
      : "LATE"
    : days > limit
      ? "LATE"
      : "IN_PROGRESS";

  const lead = reached ? `Value reached on day ${days}.` : `Day ${days} and value not reached yet.`;
  let compare: string;
  if (cohort) {
    const who = `Similar accounts (${cohort.label}, ${cohort.size} peer${cohort.size === 1 ? "" : "s"})`;
    compare = `${who} reach it by day ${cohort.medianDays}`;
    compare += !reached && verdict === "LATE" ? `; 3 in 4 by day ${cohort.p75Days}.` : ".";
    if (cohort.fellBack)
      compare += ` (fewer than ${input.minPeers} accounts matched more closely, so all ${cohort.label} were used)`;
  } else
    compare = `The plan's own target was day ${input.targetDays}; no similar accounts have reached value yet to compare with.`;

  return {
    state: reached ? "REACHED" : "NOT_REACHED",
    days,
    verdict,
    reason: `${lead} ${compare}`,
    ownTargetDays: input.targetDays,
    cohort,
    sources: [
      ...input.valueEvidence,
      ...choice.members.map((p) => ({
        sourceType: "OnboardingPlan",
        sourceId: p.planId,
        value: p.ttvDays,
        date: null,
      })),
    ],
  };
}
