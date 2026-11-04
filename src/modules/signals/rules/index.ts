import { addDays, daysBetween, type CalendarDate } from "@/lib/dates";
import {
  currentHolder,
  currentUsage,
  formatDay,
  inRange,
  rolesKnown,
  statusAsOf,
  typicalWeekday,
  validOn,
  type AccountBundle,
  type SourceRef,
} from "@/modules/health/service";
import {
  DEFAULT_STALL_PARAMS,
  detectStall,
  factsFromBundle,
  keyFeaturesUnused,
  noActivity,
  overdueSteps,
  ttvLate,
  type Blocker,
  type OnboardingPlanFacts,
} from "@/modules/onboarding/service";
import { promiseStatus, type PromiseEvidence } from "@/modules/promises/schemas";
import { TEXT_EVALUATORS, type TextFact } from "./text";
import { parseParams, RULE_BY_KEY, type ParamsOf, type RuleKey } from "./catalog";

/**
 * Deterministic signal rules (ARCHITECTURE §5.1–5.2). Each evaluator is a pure function of the
 * point-in-time bundle, its thresholds and the as-of date; it never reads the clock or the
 * database. Golden fixtures in __tests__/fixtures prove each fires — and does not — as specified.
 */
/**
 * M7 B1: what the expansion rules read beyond the health bundle. Live-signal only (never read by
 * health scoring, so the health input hash is unchanged). Absent = not loaded: nothing fires.
 */
export interface ExpansionFacts {
  /** null = no per-user usage at all. `historyFrom` is the earliest day with per-user rows. */
  people: {
    historyFrom: CalendarDate;
    users: Array<{
      externalUserId: string;
      firstSeen: CalendarDate;
      contactId: string | null;
      email: string | null;
    }>;
  } | null;
  /** The contract's credits and the latest credits-used figure; null when either is not on file. */
  credits: {
    purchased: number;
    used: number;
    usedDate: CalendarDate;
    usageRowId: string;
  } | null;
  /** Open goals whose measure is explicitly seats or users. */
  goals: Array<{ id: string; text: string; metricKey: string; targetValue: number | null }>;
}

/** M9: one promise as the promise rules read it (dates and records only, never a stored status). */
export type { TextFact };

export interface PromiseFacts {
  id: string;
  party: "US" | "CUSTOMER" | "UNCLEAR";
  what: string;
  dueDate: CalendarDate | null;
  ownerMembershipId: string | null;
  evidence: PromiseEvidence | null;
  sourceType: "MESSAGE" | "NOTE" | "CALL_TRANSCRIPT" | "TICKET" | "SURVEY_RESPONSE" | "FILE" | null;
  sourceId: string | null;
  quote: string | null;
}

export interface SignalBundle extends AccountBundle {
  /** Live-signal only (never read by health scoring, D-56). */
  invoiceFailureCounts: Record<string, number>;
  /** null = no meeting data source yet (the meeting rule is dormant, D-61). */
  meetings: Array<{ id: string; date: CalendarDate }> | null;
  /** M6: the account's open onboarding plan, or absent / null when it has none. */
  onboarding?: OnboardingPlanFacts | null;
  /** M7 B1: expansion facts; absent when not loaded (the rules then return nothing). */
  expansion?: ExpansionFacts | null;
  /** M9: the account's promises; absent when not loaded (the promise rules then return nothing). */
  promises?: PromiseFacts[] | null;
  /** M9: the account's verified text extractions, cut at the as-of date; absent = not loaded. */
  text?: TextFact[] | null;
}

export type Severity = "INFO" | "WARN" | "CRITICAL";
export interface Evidence extends SourceRef {
  value?: number | string | null;
  date?: CalendarDate | null;
}
export interface SignalCandidate {
  dedupeKey: string;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: Evidence[];
  /** The numbers that fired it; compared later to decide "materially worse" (D-53). */
  values: Record<string, number | string | null>;
}
export interface EvalContext {
  /** Whether an episode with this key is open now (fire/clear hysteresis). */
  isOpen: (dedupeKey: string) => boolean;
}

type Evaluator<K extends RuleKey> = (
  b: SignalBundle,
  p: ParamsOf<K>,
  ctx: EvalContext,
) => SignalCandidate[];

const SOURCE_TYPE_NAME = {
  MESSAGE: "Message",
  NOTE: "Note",
  CALL_TRANSCRIPT: "CallTranscript",
  TICKET: "Ticket",
  SURVEY_RESPONSE: "SurveyResponse",
  FILE: "File",
} as const;

/** The promise itself, then the record it was said in: both open from the signal's evidence. */
function promiseEvidence(p: PromiseFacts, daysLate: number | null): Evidence[] {
  return [
    { sourceType: "Promise", sourceId: p.id, value: daysLate, date: p.dueDate },
    ...(p.sourceType && p.sourceId
      ? [{ sourceType: SOURCE_TYPE_NAME[p.sourceType], sourceId: p.sourceId }]
      : []),
  ];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ROLE_WORDS: Record<string, string> = {
  CHAMPION: "Champion",
  DECISION_MAKER: "Decision maker",
  EXEC_SPONSOR: "Exec sponsor",
  BILLING: "Billing contact",
  DAILY_USER: "Daily user",
  OTHER: "Contact",
};

/** Distinct active users in the 28 days ending yesterday, or the latest seats-used figure. */
function seatsInUse(b: SignalBundle): { used: number; source: Evidence } | null {
  const to = addDays(b.asOf, -1);
  const from = addDays(to, -27);
  if (b.userUsage && b.userUsage.some((u) => inRange(u.date, from, to))) {
    const used = new Set(
      b.userUsage
        .filter((u) => u.events > 0 && inRange(u.date, from, to))
        .map((u) => u.externalUserId),
    ).size;
    return {
      used,
      source: { sourceType: "UserUsageDaily", accountId: b.accountId, from, to, value: used },
    };
  }
  const row = (b.usage ?? []).filter((u) => u.date <= to && u.seatsUsed !== null).at(-1);
  if (!row || row.date < from) return null;
  return {
    used: row.seatsUsed!,
    source: { sourceType: "UsageDaily", sourceId: row.id, value: row.seatsUsed, date: row.date },
  };
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The team behind a burst of new people, named only from data: an email subdomain (three or more
 * labels, e.g. design.acme.com → "Design") shared by most of the new people that is not simply
 * the domain most established people use. Anything else: null, and the signal says so.
 */
export function teamFromEmails(
  fresh: Array<string | null>,
  established: Array<string | null>,
  p: { teamShare: number; teamMinPeople: number },
): string | null {
  const domain = (e: string | null) =>
    e && e.includes("@") ? e.split("@").pop()!.toLowerCase() : null;
  const count = (xs: Array<string | null>) => {
    const m = new Map<string, number>();
    for (const d of xs.map(domain)) if (d) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
  };
  const withEmail = fresh.filter((e) => domain(e)).length;
  if (withEmail === 0) return null;
  const top = [...count(fresh)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (!top) return null;
  const [d, n] = top;
  if (n < p.teamMinPeople || n < Math.ceil(p.teamShare * withEmail)) return null;
  const labels = d.split(".");
  if (labels.length < 3) return null;
  const known = established.filter((e) => domain(e)).length;
  if (known > 0 && (count(established).get(d) ?? 0) * 2 >= known) return null;
  const first = labels[0]!;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const openTickets = (b: SignalBundle) =>
  b.tickets.filter(
    (t) => t.openedDate <= b.asOf && (t.closedDate === null || t.closedDate > b.asOf),
  );

const EVALUATORS: { [K in RuleKey]: Evaluator<K> } = {
  usage_drop_vs_normal: (b, p, ctx) => {
    const w = currentUsage(b, 3);
    const base = b.ownBaseline;
    if (
      !w.ok ||
      !base ||
      base.historyDays < 28 ||
      base.median === null ||
      base.median < p.minNormalUsers
    )
      return [];
    const rows = (b.usage ?? []).filter((u) => u.date <= b.asOf);
    const current = (typicalWeekday(rows, w.to) + typicalWeekday(rows, addDays(w.to, -7))) / 2;
    const ratio = current / base.median;
    const key = `usage_drop_vs_normal:${b.accountId}`;
    if (ratio > p.clearRatio || (ratio > p.warnRatio && !ctx.isOpen(key))) return [];
    const from = addDays(w.to, -13);
    return [
      {
        dedupeKey: key,
        severity: ratio <= p.criticalRatio ? "CRITICAL" : "WARN",
        title: `Usage fell to ${pct(ratio)} of normal`,
        explanation: `Typical weekday active users over the last 14 days averaged ${Math.round(current * 10) / 10}, against this account's normal of ${Math.round(base.median * 10) / 10} (${formatDay(base.from)} – ${formatDay(base.to)}).`,
        evidence: [
          {
            sourceType: "UsageDaily",
            accountId: b.accountId,
            from,
            to: w.to,
            value: Math.round(current * 10) / 10,
          },
          {
            sourceType: "UsageDaily",
            accountId: b.accountId,
            from: base.from,
            to: base.to,
            value: base.median,
          },
        ],
        values: { ratio: Math.round(ratio * 10_000) / 10_000, current, normal: base.median },
      },
    ];
  },

  key_feature_stopped: (b, p) => {
    if (!b.featureUsage) return [];
    const quietFrom = addDays(b.asOf, -p.quietDays);
    const out: SignalCandidate[] = [];
    for (const f of b.keyFeatures) {
      const rows = b.featureUsage.filter(
        (u) => u.featureKey === f.featureKey && u.users > 0 && u.date <= b.asOf,
      );
      if (rows.some((u) => u.date >= quietFrom)) continue;
      let active = 0;
      for (let k = 0; k < 8; k++) {
        const end = addDays(b.asOf, -(p.quietDays + 1) - 7 * k);
        if (rows.some((u) => inRange(u.date, addDays(end, -6), end))) active++;
      }
      if (active < p.activeWeeks) continue;
      const last = rows
        .map((u) => u.date)
        .sort()
        .at(-1)!;
      const quiet = daysBetween(last, b.asOf);
      out.push({
        dedupeKey: `key_feature_stopped:${b.accountId}:${f.featureKey}`,
        severity: "WARN",
        title: `${f.label} not used for ${quiet} days`,
        explanation: `${f.label} was used in ${active} of the 8 weeks before the last ${p.quietDays} days, and not since ${formatDay(last)}.`,
        evidence: [
          {
            sourceType: "FeatureUsageDaily",
            accountId: b.accountId,
            from: addDays(b.asOf, -(p.quietDays + 56)),
            to: addDays(b.asOf, -1),
            value: f.featureKey,
            date: last,
          },
        ],
        values: { featureKey: f.featureKey, activeWeeks: active, lastUsed: last },
      });
    }
    return out;
  },

  power_user_quiet: (b, p) => {
    if (!b.userUsage) return [];
    const from = addDays(b.asOf, -90);
    const to = addDays(b.asOf, -(p.quietDays + 1));
    const window = b.userUsage.filter((u) => inRange(u.date, from, to));
    if (new Set(window.map((u) => u.date)).size < 28) return [];
    const totals = new Map<string, number>();
    for (const u of window)
      totals.set(u.externalUserId, (totals.get(u.externalUserId) ?? 0) + u.events);
    const ranked = [...totals]
      .filter(([, e]) => e > 0)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const power = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.1))).map(([id]) => id);
    const weeks = Array.from(
      { length: 10 },
      (_, k) => [addDays(to, -6 - 7 * k), addDays(to, -7 * k)] as const,
    );
    const recentFrom = addDays(b.asOf, -p.quietDays);
    const champion = currentHolder(b, "CHAMPION");
    const out: SignalCandidate[] = [];
    for (const id of power) {
      const rows = b.userUsage.filter((u) => u.externalUserId === id && u.events > 0);
      const share =
        weeks.filter(([s, e]) => rows.some((u) => inRange(u.date, s, e))).length / weeks.length;
      if (share < p.minActiveWeekShare) continue;
      if (rows.some((u) => u.date >= recentFrom && u.date <= b.asOf)) continue;
      const who = b.userUsage.find((u) => u.externalUserId === id)!;
      const name = who.name ?? `User ${id}`;
      const last =
        rows
          .map((u) => u.date)
          .filter((d) => d <= b.asOf)
          .sort()
          .at(-1) ?? null;
      const isChampion = champion !== null && who.contactId === champion.contact.id;
      out.push({
        dedupeKey: `power_user_quiet:${b.accountId}:${id}`,
        severity: isChampion ? "CRITICAL" : "WARN",
        title: `${name} has gone quiet`,
        explanation: `${name} was one of this account's most active people (active in ${Math.round(share * 10)} of 10 weeks) and ${last ? `has not used the product since ${formatDay(last)} (${daysBetween(last, b.asOf)} days)` : `has had no activity for ${p.quietDays} days`}.${isChampion ? " They are the account's champion." : ""}`,
        evidence: [
          {
            sourceType: "UserUsageDaily",
            accountId: b.accountId,
            from,
            to: addDays(b.asOf, -1),
            value: id,
            date: last,
          },
          ...(who.contactId ? [{ sourceType: "Contact", sourceId: who.contactId }] : []),
        ],
        values: { externalUserId: id, lastActive: last, champion: isChampion ? 1 : 0 },
      });
    }
    return out;
  },

  seats_near_limit: (b, p, ctx) => {
    const out: SignalCandidate[] = [];
    const seats = b.contract?.seatsPurchased;
    const inUse = seatsInUse(b);
    if (b.contract && seats && inUse) {
      const ratio = inUse.used / seats;
      const key = `seats_near_limit:${b.accountId}:${b.contract.id}`;
      if (!(ratio < p.clearBelow || (ratio < p.infoAt && !ctx.isOpen(key))))
        out.push({
          dedupeKey: key,
          severity: ratio >= p.warnAt ? "WARN" : "INFO",
          title: `${inUse.used} of ${seats} seats in use`,
          explanation: `${inUse.used === 1 ? "1 person" : `${inUse.used} people`} used the product in the last 28 days on a contract for ${seats} seat${seats === 1 ? "" : "s"} (${pct(ratio)}).`,
          evidence: [
            inUse.source,
            { sourceType: "Contract", sourceId: b.contract.id, value: seats },
          ],
          values: { ratio: Math.round(ratio * 10_000) / 10_000, used: inUse.used, seats },
        });
    }
    // M7 B1: credits, with the same thresholds. Only when the contract has credits and usage
    // reports them; a missing figure is silence, never 0.
    const credits = b.expansion?.credits;
    if (b.contract && credits && credits.purchased > 0) {
      const ratio = credits.used / credits.purchased;
      const key = `seats_near_limit:${b.accountId}:${b.contract.id}:credits`;
      if (!(ratio < p.clearBelow || (ratio < p.infoAt && !ctx.isOpen(key))))
        out.push({
          dedupeKey: key,
          severity: ratio >= p.warnAt ? "WARN" : "INFO",
          title: `${credits.used} of ${credits.purchased} credits used`,
          explanation: `Usage on ${formatDay(credits.usedDate)} reports ${credits.used} credits used on a contract for ${credits.purchased} (${pct(ratio)}).`,
          evidence: [
            {
              sourceType: "UsageDaily",
              sourceId: credits.usageRowId,
              value: credits.used,
              date: credits.usedDate,
            },
            { sourceType: "Contract", sourceId: b.contract.id, value: credits.purchased },
          ],
          values: {
            ratio: Math.round(ratio * 10_000) / 10_000,
            used: credits.used,
            credits: credits.purchased,
          },
        });
    }
    return out;
  },

  new_team_using: (b, p, ctx) => {
    const people = b.expansion?.people;
    if (!people || b.onboarding) return [];
    const key = `new_team_using:${b.accountId}`;
    const windowFrom = addDays(b.asOf, -p.windowDays);
    const windowTo = addDays(b.asOf, -1);
    const stableFrom = addDays(windowFrom, -p.stableDays);
    // Without per-user history reaching before the stable period we cannot tell who is new.
    if (people.historyFrom >= stableFrom) return [];
    const fresh = people.users.filter((u) => inRange(u.firstSeen, windowFrom, windowTo));
    if (fresh.length < p.minNewPeople) return [];
    const earlier = people.users.filter((u) =>
      inRange(u.firstSeen, stableFrom, addDays(windowFrom, -1)),
    );
    if (earlier.length > p.stableMaxNew && !ctx.isOpen(key)) return [];
    const team = teamFromEmails(
      fresh.map((u) => u.email),
      people.users.filter((u) => u.firstSeen < windowFrom).map((u) => u.email),
      p,
    );
    const first = fresh.map((u) => u.firstSeen).sort()[0]!;
    return [
      {
        dedupeKey: key,
        severity: "INFO",
        title: team
          ? `New team using the product: ${team} (${fresh.length} people)`
          : `${fresh.length} new people started using the product`,
        explanation: `${fresh.length} people with no earlier activity first used the product between ${formatDay(first)} and ${formatDay(windowTo)}, after ${p.stableDays} days with ${earlier.length} new ${earlier.length === 1 ? "person" : "people"}. ${
          team
            ? `Most of them share the email subdomain of the ${team} team.`
            : "No shared email subdomain is on file for them, so the team is not named."
        }`,
        evidence: [
          {
            sourceType: "UserUsageDaily",
            accountId: b.accountId,
            from: first,
            to: windowTo,
            value: fresh.length,
          },
          ...fresh
            .filter((u) => u.contactId)
            .slice(0, 5)
            .map((u) => ({ sourceType: "Contact", sourceId: u.contactId! })),
        ],
        values: { newPeople: fresh.length, team },
      },
    ];
  },

  fast_growth: (b, p, ctx) => {
    if (b.onboarding) return [];
    const w = currentUsage(b, 3);
    if (!w.ok) return [];
    const rows = (b.usage ?? []).filter((u) => u.date <= b.asOf);
    // Eight weekly levels ending 14 days before the latest week: this account's own normal.
    const weeks = Array.from({ length: 8 }, (_, k) => addDays(w.to, -14 - 7 * k));
    const covered = weeks.filter(
      (end) => rows.filter((u) => inRange(u.date, addDays(end, -6), end)).length >= 5,
    );
    if (covered.length < 8) return [];
    const normal = medianOf(covered.map((end) => typicalWeekday(rows, end)));
    if (normal === null || normal < p.minNormalUsers) return [];
    const current = (typicalWeekday(rows, w.to) + typicalWeekday(rows, addDays(w.to, -7))) / 2;
    const ratio = current / normal;
    const key = `fast_growth:${b.accountId}`;
    if (ratio < p.clearRatio || (ratio < p.growthRatio && !ctx.isOpen(key))) return [];
    const normalFrom = addDays(weeks[7]!, -6);
    return [
      {
        dedupeKey: key,
        severity: ratio >= p.strongRatio ? "WARN" : "INFO",
        title: `Usage grew to ${pct(ratio)} of normal`,
        explanation: `Typical weekday active users over the last 14 days averaged ${Math.round(current * 10) / 10}, against this account's normal of ${Math.round(normal * 10) / 10} (${formatDay(normalFrom)} – ${formatDay(weeks[0]!)}).`,
        evidence: [
          {
            sourceType: "UsageDaily",
            accountId: b.accountId,
            from: addDays(w.to, -13),
            to: w.to,
            value: Math.round(current * 10) / 10,
          },
          {
            sourceType: "UsageDaily",
            accountId: b.accountId,
            from: normalFrom,
            to: weeks[0]!,
            value: Math.round(normal * 10) / 10,
          },
        ],
        values: { ratio: Math.round(ratio * 10_000) / 10_000, current, normal },
      },
    ];
  },

  goal_stated_expansion: (b) => {
    const seats = b.contract?.seatsPurchased;
    if (!b.contract || !seats) return [];
    return (b.expansion?.goals ?? [])
      .filter(
        (g) =>
          (g.metricKey === "seats" || g.metricKey === "users") &&
          g.targetValue !== null &&
          g.targetValue > seats,
      )
      .map((g) => ({
        dedupeKey: `goal_stated_expansion:${b.accountId}:${g.id}`,
        severity: "INFO" as const,
        title: `Goal needs ${g.targetValue} ${g.metricKey}; the contract has ${seats}`,
        explanation: `The goal “${g.text}” targets ${g.targetValue} ${g.metricKey}, and the contract in force includes ${seats} seat${seats === 1 ? "" : "s"}.`,
        evidence: [
          { sourceType: "Goal", sourceId: g.id, value: g.targetValue },
          { sourceType: "Contract", sourceId: b.contract!.id, value: seats },
        ],
        values: { target: g.targetValue, seats },
      }));
  },

  seats_unused: (b, p, ctx) => {
    const seats = b.contract?.seatsPurchased;
    const inUse = seatsInUse(b);
    if (!b.contract || !seats || !inUse) return [];
    if (daysBetween(b.contract.startDate, b.asOf) < p.minContractDays) return [];
    const ratio = inUse.used / seats;
    const key = `seats_unused:${b.accountId}:${b.contract.id}`;
    if (ratio > p.clearAbove || (ratio > p.warnAtOrBelow && !ctx.isOpen(key))) return [];
    return [
      {
        dedupeKey: key,
        severity: "WARN",
        title: `Only ${inUse.used} of ${seats} seats in use`,
        explanation: `${inUse.used === 1 ? "1 person" : `${inUse.used} people`} used the product in the last 28 days on a contract for ${seats} seat${seats === 1 ? "" : "s"} (${pct(ratio)}).`,
        evidence: [inUse.source, { sourceType: "Contract", sourceId: b.contract.id, value: seats }],
        values: { ratio: Math.round(ratio * 10_000) / 10_000, used: inUse.used, seats },
      },
    ];
  },

  ticket_open_too_long: (b, p) =>
    openTickets(b).flatMap((t): SignalCandidate[] => {
      const age = daysBetween(t.openedDate, b.asOf);
      const target = p.targetDays[t.priority];
      if (age <= target) return [];
      return [
        {
          dedupeKey: `ticket_open_too_long:${b.accountId}:${t.id}`,
          severity: age > target * p.criticalMultiple ? "CRITICAL" : "WARN",
          title: `Ticket open ${age} days: ${t.subject}`,
          explanation: `This ${t.priority.toLowerCase()}-priority ticket has been open ${age} days since ${formatDay(t.openedDate)}; the target is ${target}.`,
          evidence: [{ sourceType: "Ticket", sourceId: t.id, value: age, date: t.openedDate }],
          values: { age, target, priority: t.priority },
        },
      ];
    }),

  ticket_escalated: (b) =>
    openTickets(b)
      .filter((t) => t.escalatedDate !== null && t.escalatedDate <= b.asOf)
      .map((t) => ({
        dedupeKey: `ticket_escalated:${b.accountId}:${t.id}`,
        severity: t.priority === "URGENT" ? ("CRITICAL" as const) : ("WARN" as const),
        title: `Escalated ticket: ${t.subject}`,
        explanation: `This ${t.priority.toLowerCase()}-priority ticket was escalated on ${formatDay(t.escalatedDate!)} and is still open.`,
        evidence: [
          { sourceType: "Ticket", sourceId: t.id, value: t.priority, date: t.escalatedDate },
        ],
        values: { priority: t.priority },
      })),

  payment_failed: (b, p) =>
    b.invoices
      .filter(
        (i) =>
          !i.isVoid &&
          i.failedDate !== null &&
          i.failedDate <= b.asOf &&
          (i.paidDate === null || i.paidDate > b.asOf),
      )
      .map((i) => {
        const failures = b.invoiceFailureCounts[i.id] ?? 1;
        return {
          dedupeKey: `payment_failed:${b.accountId}:${i.id}`,
          severity: failures >= p.criticalFailures ? ("CRITICAL" as const) : ("WARN" as const),
          title: `Payment failed: invoice ${i.number}`,
          explanation: `The payment for invoice ${i.number} failed${failures > 1 ? ` ${failures} times` : ""}, most recently on ${formatDay(i.failedDate!)}, and it is unpaid.`,
          evidence: [
            { sourceType: "Invoice", sourceId: i.id, value: failures, date: i.failedDate },
          ],
          values: { failures },
        };
      }),

  invoice_late: (b, p) =>
    b.invoices
      .filter(
        (i) =>
          !i.isVoid &&
          i.failedDate === null &&
          (i.paidDate === null || i.paidDate > b.asOf) &&
          daysBetween(i.dueDate, b.asOf) > p.graceDays,
      )
      .map((i) => {
        const late = daysBetween(i.dueDate, b.asOf);
        return {
          dedupeKey: `invoice_late:${b.accountId}:${i.id}`,
          severity: "WARN" as const,
          title: `Invoice ${i.number} is ${late} days late`,
          explanation: `Invoice ${i.number} was due on ${formatDay(i.dueDate)} and is still unpaid.`,
          evidence: [{ sourceType: "Invoice", sourceId: i.id, value: late, date: i.dueDate }],
          values: { daysLate: late },
        };
      }),

  renewal_window_90: (b, p) => renewal("renewal_window_90", b, p, "INFO"),
  renewal_window_60: (b, p) => renewal("renewal_window_60", b, p, "INFO"),
  renewal_window_30: (b, p) => renewal("renewal_window_30", b, p, "WARN"),

  no_meeting_in_x_days: (b, p) => {
    // Dormant until meeting data exists (D-61): absent data never fires and never means "all clear".
    if (b.meetings === null || b.tier === "LONG_TAIL") return [];
    const limit = b.tier === "HIGH_TOUCH" ? p.highTouchDays : p.midTouchDays;
    const last = b.meetings
      .filter((m) => m.date <= b.asOf)
      .sort((x, y) => (x.date < y.date ? 1 : -1))[0];
    if (!last) return [];
    const days = daysBetween(last.date, b.asOf);
    if (days <= limit) return [];
    return [
      {
        dedupeKey: `no_meeting_in_x_days:${b.accountId}`,
        severity: "WARN",
        title: `No meeting for ${days} days`,
        explanation: `The last meeting was on ${formatDay(last.date)}; the limit for this tier is ${limit} days.`,
        evidence: [{ sourceType: "Meeting", sourceId: last.id, value: days, date: last.date }],
        values: { days, limit },
      },
    ];
  },

  contact_bounced_or_left: (b, p) => {
    const out: SignalCandidate[] = [];
    for (const c of b.contacts) {
      const status = statusAsOf(c, b.asOf);
      if (status !== "BOUNCED" && status !== "LEFT") continue;
      const roles = rolesKnown(b).filter(
        (r) => r.contactId === c.id && validOn(r, b.asOf) && (p.roles as string[]).includes(r.role),
      );
      if (roles.length === 0) continue;
      const main = roles.find((r) => r.role === "CHAMPION") ?? roles[0]!;
      const word = ROLE_WORDS[main.role] ?? "Contact";
      out.push({
        dedupeKey: `contact_bounced_or_left:${b.accountId}:${c.id}:${status}`,
        severity: main.role === "CHAMPION" ? "CRITICAL" : "WARN",
        title:
          status === "BOUNCED" ? `${word} ${c.name}: email bounced` : `${word} ${c.name} has left`,
        explanation:
          status === "BOUNCED"
            ? `Email to ${c.name} bounced${c.statusDate ? ` on ${formatDay(c.statusDate)}` : ""}. They are still recorded as ${word.toLowerCase()}.`
            : `${c.name} left the company${c.statusDate ? ` on ${formatDay(c.statusDate)}` : ""}. They are still recorded as ${word.toLowerCase()}.`,
        evidence: [
          { sourceType: "Contact", sourceId: c.id, value: status, date: c.statusDate },
          { sourceType: "StakeholderRole", sourceId: main.id, value: main.role },
        ],
        values: { status, role: main.role },
      });
    }
    return out;
  },

  // Entered by people with a dated public source (INTERP-6); never raised by an evaluator.
  outside_event: () => [],

  // ─── M9: text rules (rules/text.ts). Verified extractions only. ───
  ...TEXT_EVALUATORS,

  // ─── M9: promises. Status comes from the one function in promises/status.ts (D1). ───
  promise_late: (b, p) =>
    (b.promises ?? [])
      .filter((x) => x.party === "US")
      .flatMap((x) => {
        const r = promiseStatus({
          dueDate: x.dueDate,
          today: b.asOf,
          evidence: x.evidence,
          brokenAfterDays: p.brokenAfterDays,
        });
        if (r.status !== "LATE" && r.status !== "BROKEN") return [];
        return [
          {
            dedupeKey: `promise_late:${b.accountId}:${x.id}`,
            severity: r.status === "BROKEN" ? ("CRITICAL" as const) : ("WARN" as const),
            title: `Promise late: ${x.what} (${r.daysLate} ${r.daysLate === 1 ? "day" : "days"})`,
            explanation: `We promised “${x.what}” by ${formatDay(x.dueDate!)}; ${r.reason}${
              x.quote ? ` Said: “${x.quote}”` : ""
            }`,
            evidence: promiseEvidence(x, r.daysLate),
            values: { daysLate: r.daysLate, dueDate: x.dueDate },
          },
        ];
      }),

  promise_no_owner: (b, p) =>
    (b.promises ?? [])
      .filter((x) => x.party === "US" && x.ownerMembershipId === null && x.dueDate !== null)
      .flatMap((x) => {
        const r = promiseStatus({
          dueDate: x.dueDate,
          today: b.asOf,
          evidence: x.evidence,
          brokenAfterDays: 14,
        });
        if (r.status === "KEPT") return [];
        const toDue = daysBetween(b.asOf, x.dueDate!);
        if (toDue > p.dueWithinDays) return [];
        return [
          {
            dedupeKey: `promise_no_owner:${b.accountId}:${x.id}`,
            severity: toDue < 0 ? ("WARN" as const) : ("INFO" as const),
            title: `Promise has no owner: ${x.what}`,
            explanation: `We promised “${x.what}” by ${formatDay(x.dueDate!)} and nobody on our side owns it.`,
            evidence: promiseEvidence(x, null),
            values: { daysToDue: toDue },
          },
        ];
      }),

  // ─── M6: onboarding, all through the one stall definition (onboarding/stall.ts, D4) ───
  onboarding_stall: (b, p) => {
    const f = factsFromBundle(b);
    if (!f) return [];
    const r = detectStall(f, p);
    if (!r.stalled) return [];
    return [
      {
        dedupeKey: `onboarding_stall:${b.accountId}:${f.planId}`,
        severity: r.blockers.length > 1 ? "CRITICAL" : "WARN",
        title: `Onboarding stalled: ${r.reason}`,
        explanation: `Likely blocker: ${r.reason}.${
          r.blockers.length > 1
            ? ` Also: ${r.blockers
                .slice(1)
                .map((x) => x.text)
                .join("; ")}.`
            : ""
        }`,
        evidence: r.blockers.flatMap((x) => evidenceOf(b, x)),
        values: { blockers: r.blockers.length, first: r.blockers[0]!.kind },
      },
    ];
  },
  onboarding_step_overdue_customer: (b, p) => {
    const f = factsFromBundle(b);
    if (!f) return [];
    return overdueSteps(f, "CUSTOMER", {
      ...DEFAULT_STALL_PARAMS,
      stepOverdueDays: p.stepOverdueDays,
    }).map((x) => ({
      dedupeKey: `onboarding_step_overdue_customer:${b.accountId}:${x.ref}`,
      severity: x.days >= p.criticalDays ? "CRITICAL" : "WARN",
      title: x.text,
      explanation: `The customer owns this onboarding step and it is ${x.days} days past its due date.`,
      evidence: evidenceOf(b, x),
      values: { days: x.days },
    }));
  },
  onboarding_no_activity: (b, p) => {
    const f = factsFromBundle(b);
    if (!f) return [];
    const x = noActivity(f, { ...DEFAULT_STALL_PARAMS, noActivityDays: p.noActivityDays });
    if (!x) return [];
    return [
      {
        dedupeKey: `onboarding_no_activity:${b.accountId}:${f.planId}`,
        severity: x.days >= p.criticalDays ? "CRITICAL" : "WARN",
        title: x.text,
        explanation: `${x.text}, during onboarding (plan started ${formatDay(f.startDate)}).`,
        evidence: evidenceOf(b, x),
        values: { days: x.days },
      },
    ];
  },
  onboarding_key_feature_unused: (b, p) => {
    const f = factsFromBundle(b);
    if (!f) return [];
    return keyFeaturesUnused(f, {
      ...DEFAULT_STALL_PARAMS,
      keyFeatureByDay: p.keyFeatureByDay,
    }).map((x) => ({
      dedupeKey: `onboarding_key_feature_unused:${b.accountId}:${f.planId}:${x.ref}`,
      severity: "WARN",
      title: x.text,
      explanation: `${x.text}. It is a key feature of the account's plan.`,
      evidence: evidenceOf(b, x),
      values: { day: x.days + p.keyFeatureByDay },
    }));
  },
  onboarding_ttv_late: (b) => {
    const f = factsFromBundle(b);
    if (!f || f.valueReachedAt) return [];
    const x = ttvLate(f);
    if (!x) return [];
    return [
      {
        dedupeKey: `onboarding_ttv_late:${b.accountId}:${f.planId}`,
        severity: "WARN",
        title: `Time to value late: day ${x.days}`,
        explanation: x.text,
        evidence: evidenceOf(b, x),
        values: { days: x.days, p75: f.ttv?.cohort?.p75Days ?? f.ttv?.ownTargetDays ?? null },
      },
    ];
  },
};

/** Blocker sources as signal evidence; ranges are about this account. */
function evidenceOf(b: SignalBundle, x: Blocker): Evidence[] {
  return x.sources.map((s) => (s.sourceId ? s : { ...s, accountId: b.accountId }));
}

function renewal(
  key: "renewal_window_90" | "renewal_window_60" | "renewal_window_30",
  b: SignalBundle,
  p: { fromDays: number; toDays: number },
  severity: Severity,
): SignalCandidate[] {
  const date = b.contract?.renewalDate;
  if (!b.contract || !date) return [];
  const days = daysBetween(b.asOf, date);
  if (days < p.fromDays || days > p.toDays) return [];
  return [
    {
      dedupeKey: `${key}:${b.accountId}:${b.contract.id}:${date}`,
      severity,
      title: `Renewal in ${days} days`,
      explanation: `The contract renews on ${formatDay(date)}.`,
      evidence: [{ sourceType: "Contract", sourceId: b.contract.id, value: days, date }],
      values: { days, renewalDate: date },
    },
  ];
}

export function evaluateRule<K extends RuleKey>(
  key: K,
  bundle: SignalBundle,
  rawParams: unknown,
  ctx: EvalContext = { isOpen: () => false },
): SignalCandidate[] {
  if (!RULE_BY_KEY.has(key)) throw new Error(`Unknown rule ${key}`);
  return EVALUATORS[key](bundle, parseParams(key, rawParams), ctx);
}

/** Ratios are floats: 1.0 − 0.9 must count as 10 points. */
const EPS = 1e-9;

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

/**
 * D-53: a false alarm reopens (as a new episode) only when materially worse than when it was
 * marked: a higher severity always, otherwise the rule's own number.
 */
export function materiallyWorse(
  key: RuleKey,
  was: { severity: Severity; values: Record<string, unknown> },
  now: { severity: Severity; values: Record<string, unknown> },
  rawParams: unknown,
): boolean {
  if (SEVERITY_RANK[now.severity] > SEVERITY_RANK[was.severity]) return true;
  const n = (v: unknown) => (typeof v === "number" ? v : Number.NaN);
  switch (key) {
    case "usage_drop_vs_normal": {
      const p = parseParams(key, rawParams);
      return n(was.values.ratio) - n(now.values.ratio) >= p.materialDrop - EPS;
    }
    case "seats_near_limit": {
      const p = parseParams(key, rawParams);
      return n(now.values.ratio) - n(was.values.ratio) >= p.materialPoints - EPS;
    }
    case "seats_unused": {
      const p = parseParams(key, rawParams);
      return n(was.values.ratio) - n(now.values.ratio) >= p.materialPoints - EPS;
    }
    case "fast_growth": {
      const p = parseParams(key, rawParams);
      return n(now.values.ratio) - n(was.values.ratio) >= p.materialPoints - EPS;
    }
    case "payment_failed":
      return n(now.values.failures) > n(was.values.failures);
    case "invoice_late": {
      const p = parseParams(key, rawParams);
      return n(now.values.daysLate) - n(was.values.daysLate) >= p.materialDays - EPS;
    }
    default:
      // Yes/no rules (feature stopped, user quiet, escalated, renewal window, contact, ticket age
      // crossing to the next severity is covered above): severity only.
      return false;
  }
}
