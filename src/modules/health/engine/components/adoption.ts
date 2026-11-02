import { addDays } from "@/lib/dates";
import { applyCurve } from "../curves";
import { day, num, pct, period, round4, signedPct } from "../format";
import type {
  ComponentEnv,
  ComponentResult,
  PillarComponents,
  ReasonDraft,
  AccountBundle,
} from "../types";
import { currentUsage, inRange, type CurrentWindow } from "../windows";

/** Adoption (ARCHITECTURE §4.1): usage against the account's own normal and its cohort. */
const missing = (component: string, input: string, message: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input, message, sources: [] },
});

function usageGap(component: string, input: string, w: CurrentWindow): ComponentResult | null {
  if (w.ok) return null;
  return w.reason === "stale"
    ? missing(component, input, `Usage data stops on ${day(w.lastDate!)}.`)
    : missing(component, input, "No product usage data.");
}

const window = (b: AccountBundle, from: string, to: string) => ({
  sourceType: "UsageDaily",
  accountId: b.accountId,
  from,
  to,
});

function activeVsOwn(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "active_vs_own";
  const I = "active_users_typical_weekday";
  const w = currentUsage(b, env.params.usageStaleDays);
  const gap = usageGap(C, I, w);
  if (gap || !w.ok) return gap!;
  const base = b.ownBaseline;
  if (!base || base.historyDays < env.params.ownBaselineMinDays)
    return missing(
      C,
      I,
      `Not enough usage history to know this account's normal (${base?.historyDays ?? 0} days; ${env.params.ownBaselineMinDays} needed).`,
    );
  if (!base.median)
    return missing(C, I, "No usage in this account's normal period to compare with.");
  const ratio = w.value / base.median;
  const normal = period(base.from, base.to);
  const message =
    ratio < 0.95
      ? `Typical weekday active users fell from ${num(base.median)} to ${num(w.value)} (${signedPct(ratio - 1)}) against this account's normal (${normal}).`
      : ratio > 1.05
        ? `Typical weekday active users rose from ${num(base.median)} to ${num(w.value)} (${signedPct(ratio - 1)}) against this account's normal (${normal}).`
        : `Typical weekday active users are at this account's normal (${num(w.value)} vs ${num(base.median)}, ${normal}).`;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message,
      value: round4(w.value),
      baseline: round4(base.median),
      delta: round4(w.value - base.median),
      periodStart: w.from,
      periodEnd: w.to,
      sources: [window(b, w.from, w.to), window(b, base.from, base.to)],
    },
  };
}

function activeRateVsCohort(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "active_rate_vs_cohort";
  const I = "active_rate";
  const w = currentUsage(b, env.params.usageStaleDays);
  const gap = usageGap(C, I, w);
  if (gap || !w.ok) return gap!;
  const seats = b.contract?.seatsPurchased;
  if (!b.contract || !seats) return missing(C, I, "No seat count on the contract.");
  const size = b.cohort?.size ?? 0;
  if (!b.cohort || size < env.params.cohortMinPeers)
    return missing(
      C,
      I,
      `Too few similar accounts to compare with (${size}; ${env.params.cohortMinPeers} needed).`,
    );
  if (!b.cohort.medianRate)
    return missing(C, I, "No usage among similar accounts to compare with.");
  const rate = w.value / seats;
  return {
    score: applyCurve(env.curve!, rate / b.cohort.medianRate),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${pct(rate)} of ${seats} seats are active on a typical weekday, against ${pct(b.cohort.medianRate)} for ${size} ${b.cohort.label}.`,
      value: round4(rate),
      baseline: round4(b.cohort.medianRate),
      delta: round4(rate - b.cohort.medianRate),
      cohortValue: round4(b.cohort.medianRate),
      cohortKey: b.cohort.key,
      cohortSize: size,
      periodStart: w.from,
      periodEnd: w.to,
      sources: [window(b, w.from, w.to), { sourceType: "Contract", sourceId: b.contract.id }],
    },
  };
}

function seatUse(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "seat_use";
  const I = "seats_used_28d";
  const seats = b.contract?.seatsPurchased;
  if (!b.contract || !seats) return missing(C, I, "No seat count on the contract.");
  const to = addDays(b.asOf, -1);
  const from = addDays(to, -27);
  let used: number | null = null;
  let source: ReasonDraft["sources"][number] | null = null;
  if (b.userUsage) {
    const active = new Set(
      b.userUsage
        .filter((u) => u.events > 0 && inRange(u.date, from, to))
        .map((u) => u.externalUserId),
    );
    if (b.userUsage.some((u) => inRange(u.date, from, to))) {
      used = active.size;
      source = { sourceType: "UserUsageDaily", accountId: b.accountId, from, to };
    }
  }
  if (used === null) {
    const row = (b.usage ?? []).filter((u) => u.date <= to && u.seatsUsed !== null).at(-1);
    if (row && row.date >= from) {
      used = row.seatsUsed!;
      source = { sourceType: "UsageDaily", sourceId: row.id };
    }
  }
  if (used === null || !source) return missing(C, I, "No seat usage data.");
  const ratio = used / seats;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${used} of ${seats} seats were used in the last 28 days (${pct(ratio)}).`,
      value: round4(ratio),
      periodStart: from,
      periodEnd: to,
      sources: [source, { sourceType: "Contract", sourceId: b.contract.id }],
    },
  };
}

function keyFeatures(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "key_features";
  const I = "key_features_used_28d";
  const to = addDays(b.asOf, -1);
  const from = addDays(to, -27);
  const rows = (b.featureUsage ?? []).filter((f) => f.date <= to);
  if (!rows.some((f) => f.date >= addDays(to, -89))) return missing(C, I, "No feature usage data.");
  if (!b.plan) return missing(C, I, "No plan on record.");
  if (b.keyFeatures.length === 0)
    return missing(C, I, `No key features defined for the ${b.plan} plan.`);
  const used = new Set(rows.filter((f) => f.users > 0 && f.date >= from).map((f) => f.featureKey));
  const unused = b.keyFeatures.filter((k) => !used.has(k.featureKey));
  const n = b.keyFeatures.length - unused.length;
  const ratio = n / b.keyFeatures.length;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message:
        `${n} of ${b.keyFeatures.length} key features in the ${b.plan} plan were used in the last 28 days.` +
        (unused.length ? ` Not used: ${unused.map((k) => k.label).join(", ")}.` : ""),
      value: round4(ratio),
      periodStart: from,
      periodEnd: to,
      sources: [{ sourceType: "FeatureUsageDaily", accountId: b.accountId, from, to }],
    },
  };
}

function powerUsers(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "power_users";
  const I = "power_users_active_14d";
  if (!b.userUsage) return missing(C, I, "No per-user usage data.");
  const windowFrom = addDays(b.asOf, -90);
  const windowTo = addDays(b.asOf, -15);
  const recentFrom = addDays(b.asOf, -14);
  const recentTo = addDays(b.asOf, -1);
  const inWindow = b.userUsage.filter((u) => inRange(u.date, windowFrom, windowTo));
  const history = new Set(inWindow.map((u) => u.date)).size;
  if (history < env.params.ownBaselineMinDays)
    return missing(
      C,
      I,
      `Not enough per-user usage history (${history} days; ${env.params.ownBaselineMinDays} needed).`,
    );
  const totals = new Map<string, number>();
  for (const u of inWindow)
    totals.set(u.externalUserId, (totals.get(u.externalUserId) ?? 0) + u.events);
  const ranked = [...totals.entries()]
    .filter(([, e]) => e > 0)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  if (ranked.length === 0) return missing(C, I, "No active users in the normal period.");
  const power = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.1))).map(([id]) => id);
  const recent = new Set(
    b.userUsage
      .filter((u) => u.events > 0 && inRange(u.date, recentFrom, recentTo))
      .map((u) => u.externalUserId),
  );
  const quiet = power.filter((id) => !recent.has(id));
  const info = (id: string) => b.userUsage!.find((u) => u.externalUserId === id)!;
  const ratio = (power.length - quiet.length) / power.length;
  const active = power.length - quiet.length;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message:
        `${active} of ${power.length} power users ${active === 1 ? "was" : "were"} active in the last 14 days.` +
        (quiet.length
          ? ` Quiet: ${quiet.map((id) => info(id).name ?? `user ${id}`).join(", ")}.`
          : ""),
      value: round4(ratio),
      periodStart: recentFrom,
      periodEnd: recentTo,
      sources: [
        { sourceType: "UserUsageDaily", accountId: b.accountId, from: windowFrom, to: recentTo },
        ...quiet
          .map((id) => info(id).contactId)
          .filter((c): c is string => !!c)
          .map((sourceId) => ({ sourceType: "Contact", sourceId })),
      ],
    },
  };
}

export const ADOPTION: PillarComponents = {
  active_vs_own: activeVsOwn,
  active_rate_vs_cohort: activeRateVsCohort,
  seat_use: seatUse,
  key_features: keyFeatures,
  power_users: powerUsers,
};
