import { addDays, type CalendarDate } from "@/lib/dates";
import { percentile, typicalWeekday } from "@/modules/health/service";

/**
 * The Adoption view (spec §6G4, M6 §2), deterministic and in CS language. Four figures:
 *  - seats (and credits) used vs bought;
 *  - features of the account's plan used vs bought ("3 of 5 … have never been used");
 *  - power users of the month before, and how many are still active;
 *  - weekday use against the account's own normal (M3 own baseline), then its cohort (M3 cohort).
 * Every figure carries sources; missing data is said, never shown as zero (Rule 4). These are
 * the numbers agents may cite: an agent never supplies one (D-75).
 */
export interface Source {
  sourceType: string;
  sourceId?: string;
  accountId?: string;
  from?: CalendarDate;
  to?: CalendarDate;
  value: number | string | null;
  date: CalendarDate | null;
}

export interface AdoptionInput {
  accountId: string;
  asOf: CalendarDate;
  plan: string | null;
  contract: {
    id: string;
    seatsPurchased: number | null;
    creditsPurchased: number | null;
    startDate: CalendarDate;
  } | null;
  usage: Array<{
    id: string;
    date: CalendarDate;
    activeUsers: number;
    seatsUsed: number | null;
    creditsUsed: number | null;
  }> | null;
  userUsage: Array<{
    externalUserId: string;
    name: string | null;
    date: CalendarDate;
    events: number;
  }> | null;
  featureUsage: Array<{ featureKey: string; date: CalendarDate; users: number }> | null;
  catalog: Array<{
    featureKey: string;
    label: string;
    isKeyFeature: boolean;
    includedInPlans: string[];
  }>;
  /** M3 own baseline: median typical weekday active users and its window. */
  ownNormal: { median: number | null; from: CalendarDate; to: CalendarDate } | null;
  /** M3 cohort: median active rate (typical weekday active users ÷ seats) among peers. */
  cohort: { label: string; size: number; medianRate: number | null } | null;
}

export interface Adoption {
  seats: {
    used: number;
    purchased: number;
    share: number;
    status: "UNDER" | "OK" | "OVER";
    text: string;
    sources: Source[];
  } | null;
  credits: { used: number; purchased: number; text: string; sources: Source[] } | null;
  features: {
    bought: number;
    used: string[];
    neverUsed: string[];
    keyNeverUsed: string[];
    text: string;
    sources: Source[];
  } | null;
  powerUsers: {
    users: Array<{ name: string; stillActive: boolean }>;
    text: string;
    sources: Source[];
  } | null;
  trend: {
    current: number;
    normal: number | null;
    text: string;
    cohortText: string | null;
    sources: Source[];
  } | null;
  missing: string[];
}

/** Below this share of seats in use, seats are "under-used". */
export const UNDER_USE_SHARE = 0.5;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const round1 = (x: number) => Math.round(x * 10) / 10;

export function adoption(i: AdoptionInput): Adoption {
  const missing: string[] = [];
  const yesterday = addDays(i.asOf, -1);
  const usage = i.usage?.filter((u) => u.date <= i.asOf) ?? null;

  if (!i.contract) missing.push("No contract on file, so seats bought are unknown.");
  if (!usage || usage.length === 0) missing.push("No product usage data for this account yet.");
  if (!i.userUsage) missing.push("No per-person usage data, so power users cannot be shown.");
  if (!i.featureUsage) missing.push("No feature usage data, so features used cannot be shown.");

  // Seats: the latest day that reported seats in use.
  let seats: Adoption["seats"] = null;
  const seatRow = usage?.filter((u) => u.seatsUsed !== null).at(-1);
  if (seatRow && i.contract?.seatsPurchased) {
    const used = seatRow.seatsUsed!;
    const purchased = i.contract.seatsPurchased;
    const share = used / purchased;
    const status = share > 1 ? "OVER" : share < UNDER_USE_SHARE ? "UNDER" : "OK";
    seats = {
      used,
      purchased,
      share,
      status,
      text: `${used} of ${purchased} seats in use (${pct(share)})${status === "OVER" ? ": more than bought" : ""}`,
      sources: [
        { sourceType: "UsageDaily", sourceId: seatRow.id, value: used, date: seatRow.date },
      ],
    };
  }

  let credits: Adoption["credits"] = null;
  const creditRow = usage?.filter((u) => u.creditsUsed !== null).at(-1);
  if (creditRow && i.contract?.creditsPurchased) {
    credits = {
      used: creditRow.creditsUsed!,
      purchased: i.contract.creditsPurchased,
      text: `${creditRow.creditsUsed} of ${i.contract.creditsPurchased} credits used (${pct(creditRow.creditsUsed! / i.contract.creditsPurchased)})`,
      sources: [
        {
          sourceType: "UsageDaily",
          sourceId: creditRow.id,
          value: creditRow.creditsUsed,
          date: creditRow.date,
        },
      ],
    };
  }

  // Features of the plan used vs bought, since the contract started (or all history we have).
  let features: Adoption["features"] = null;
  const bought = i.plan ? i.catalog.filter((f) => f.includedInPlans.includes(i.plan!)) : [];
  if (i.featureUsage && bought.length) {
    const since = i.contract?.startDate;
    const usedKeys = new Set(
      i.featureUsage
        .filter((u) => u.users > 0 && u.date <= i.asOf && (!since || u.date >= since))
        .map((u) => u.featureKey),
    );
    const used = bought.filter((f) => usedKeys.has(f.featureKey));
    const never = bought.filter((f) => !usedKeys.has(f.featureKey));
    features = {
      bought: bought.length,
      used: used.map((f) => f.label),
      neverUsed: never.map((f) => f.label),
      keyNeverUsed: never.filter((f) => f.isKeyFeature).map((f) => f.label),
      text: never.length
        ? `${never.length} of ${bought.length} features in your ${i.plan} plan ${never.length === 1 ? "has" : "have"} never been used`
        : `All ${bought.length} features in your ${i.plan} plan have been used`,
      sources: [
        {
          sourceType: "FeatureUsageDaily",
          accountId: i.accountId,
          from: since,
          to: i.asOf,
          value: used.length,
          date: null,
        },
        ...bought.map((f) => ({
          sourceType: "FeatureCatalog",
          sourceId: f.featureKey,
          value: f.label,
          date: null,
        })),
      ],
    };
  }

  // Power users: at or above the median activity of the people active in the month before.
  let powerUsers: Adoption["powerUsers"] = null;
  if (i.userUsage) {
    const prevFrom = addDays(i.asOf, -56);
    const prevTo = addDays(i.asOf, -29);
    const recentFrom = addDays(i.asOf, -28);
    const totals = new Map<string, { name: string; events: number }>();
    for (const u of i.userUsage)
      if (u.date >= prevFrom && u.date <= prevTo && u.events > 0) {
        const t = totals.get(u.externalUserId) ?? { name: u.name ?? u.externalUserId, events: 0 };
        t.events += u.events;
        totals.set(u.externalUserId, t);
      }
    if (totals.size) {
      const cut = percentile(
        [...totals.values()].map((t) => t.events),
        0.5,
      )!;
      const recent = new Set(
        i.userUsage
          .filter((u) => u.date >= recentFrom && u.date <= yesterday && u.events > 0)
          .map((u) => u.externalUserId),
      );
      const power = [...totals]
        .filter(([, t]) => t.events >= cut)
        .sort((a, b) => b[1].events - a[1].events)
        .map(([id, t]) => ({ name: t.name, stillActive: recent.has(id) }));
      const still = power.filter((p) => p.stillActive).length;
      powerUsers = {
        users: power,
        text: `${still} of ${power.length} power user${power.length === 1 ? "" : "s"} from the month before ${still === 1 ? "is" : "are"} still active`,
        sources: [
          {
            sourceType: "UserUsageDaily",
            accountId: i.accountId,
            from: prevFrom,
            to: yesterday,
            value: power.length,
            date: null,
          },
        ],
      };
    }
  }

  // Trend: typical weekday active users now vs the account's own normal, then its cohort.
  let trend: Adoption["trend"] = null;
  if (usage && usage.length) {
    const current = round1(typicalWeekday(usage, yesterday));
    const normal = i.ownNormal?.median ?? null;
    const rate = i.contract?.seatsPurchased ? current / i.contract.seatsPurchased : null;
    trend = {
      current,
      normal,
      text:
        normal && normal > 0
          ? `Weekday use is at ${pct(current / normal)} of this account's normal (${current} ${current === 1 ? "person" : "people"} vs ${round1(normal)})`
          : `${current} ${current === 1 ? "person uses" : "people use"} the product on a typical weekday; there is not enough history yet for this account's normal`,
      cohortText:
        i.cohort?.medianRate !== null && i.cohort?.medianRate !== undefined && rate !== null
          ? `Similar accounts (${i.cohort.label}, ${i.cohort.size} peer${i.cohort.size === 1 ? "" : "s"}) have ${pct(i.cohort.medianRate)} of seats active on a typical weekday; this account has ${pct(rate)}`
          : null,
      sources: [
        {
          sourceType: "UsageDaily",
          accountId: i.accountId,
          from: addDays(yesterday, -6),
          to: yesterday,
          value: current,
          date: null,
        },
        ...(i.ownNormal && normal !== null
          ? [
              {
                sourceType: "UsageDaily",
                accountId: i.accountId,
                from: i.ownNormal.from,
                to: i.ownNormal.to,
                value: normal,
                date: null,
              },
            ]
          : []),
      ],
    };
  }

  return { seats, credits, features, powerUsers, trend, missing };
}
