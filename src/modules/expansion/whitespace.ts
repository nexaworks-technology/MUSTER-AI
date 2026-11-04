import { addDays, daysBetween, type CalendarDate } from "@/lib/dates";

/**
 * Whitespace (M7 B2): where an account has room to use more of what it already pays for, from its
 * own records. Unused plan features and seat headroom only; there is deliberately no money in it
 * (a figure comes from `estimate.ts` or not at all). Pure.
 */
export interface WhitespaceInput {
  asOf: CalendarDate;
  plan: string | null;
  catalog: Array<{ featureKey: string; label: string; includedInPlans: string[] }>;
  /** null = no per-feature usage at all for this account. */
  featureUsage: Array<{ featureKey: string; lastUsed: CalendarDate }> | null;
  seatsPurchased: number | null;
  /** Distinct active users in the last 28 days; null when not known. */
  seatsInUse: number | null;
  windowDays?: number;
}

export interface Whitespace {
  features:
    | { state: "NO_DATA"; reason: string }
    | {
        state: "OK";
        windowDays: number;
        /** Included in the plan, not used in the window; `lastUsed` null = never in the data. */
        unused: Array<{
          featureKey: string;
          label: string;
          lastUsed: CalendarDate | null;
          daysQuiet: number | null;
        }>;
        total: number;
      };
  seats:
    | { state: "NO_DATA"; reason: string }
    | { state: "OK"; purchased: number; inUse: number; headroom: number };
}

export function whitespace(i: WhitespaceInput): Whitespace {
  const windowDays = i.windowDays ?? 30;
  const included = i.plan ? i.catalog.filter((f) => f.includedInPlans.includes(i.plan!)) : [];
  let features: Whitespace["features"];
  if (!i.plan) features = { state: "NO_DATA", reason: "No plan on file for this account" };
  else if (i.featureUsage === null)
    features = { state: "NO_DATA", reason: "No per-feature usage on file" };
  else {
    const last = new Map(i.featureUsage.map((u) => [u.featureKey, u.lastUsed]));
    const from = addDays(i.asOf, -windowDays);
    const unused = included
      .filter((f) => {
        const l = last.get(f.featureKey);
        return !l || l < from;
      })
      .map((f) => {
        const l = last.get(f.featureKey) ?? null;
        return {
          featureKey: f.featureKey,
          label: f.label,
          lastUsed: l,
          daysQuiet: l ? daysBetween(l, i.asOf) : null,
        };
      });
    features = { state: "OK", windowDays, unused, total: included.length };
  }
  const seats: Whitespace["seats"] =
    i.seatsPurchased === null
      ? { state: "NO_DATA", reason: "No seat count on the contract" }
      : i.seatsInUse === null
        ? { state: "NO_DATA", reason: "No per-user usage on file" }
        : {
            state: "OK",
            purchased: i.seatsPurchased,
            inUse: i.seatsInUse,
            headroom: i.seatsPurchased - i.seatsInUse,
          };
  return { features, seats };
}
