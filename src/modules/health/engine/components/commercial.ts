import { addDays, daysBetween } from "@/lib/dates";
import { applyCurve } from "../curves";
import { day, pct, plural, round4 } from "../format";
import type { AccountBundle, ComponentEnv, ComponentResult, PillarComponents } from "../types";

/** Commercial (ARCHITECTURE §4.1). Invoice facts are read as of the date, never later. */
const missing = (component: string, input: string, message: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input, message, sources: [] },
});

function invoices90d(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "invoices_90d";
  const I = "failed_or_late_invoices_90d";
  const known = b.invoices.filter((i) => !i.isVoid && i.issuedDate <= b.asOf);
  if (known.length === 0) return missing(C, I, "No invoices on record.");
  const from = addDays(b.asOf, -89);
  const grace = env.params.invoiceGraceDays;
  const paid = (i: (typeof known)[number]) => i.paidDate !== null && i.paidDate <= b.asOf;
  const failed = known.filter((i) => i.failedDate !== null && i.failedDate <= b.asOf && !paid(i));
  const late = known.filter(
    (i) => !failed.includes(i) && !paid(i) && daysBetween(i.dueDate, b.asOf) > grace,
  );
  const unresolved = [...failed, ...late];
  const describe = (i: (typeof known)[number]) =>
    failed.includes(i)
      ? `${i.number} failed on ${day(i.failedDate!)}`
      : `${i.number} is ${plural(daysBetween(i.dueDate, b.asOf), "day")} past due`;
  if (unresolved.length >= 2)
    return {
      score: 0,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: `${unresolved.length} invoices are unpaid: ${unresolved.map(describe).join("; ")}.`,
        value: unresolved.length,
        periodEnd: b.asOf,
        sources: unresolved.map((i) => ({ sourceType: "Invoice", sourceId: i.id })),
      },
    };
  if (unresolved.length === 1) {
    const i = unresolved[0]!;
    return {
      score: 30,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: failed.includes(i)
          ? `Invoice ${i.number} failed on ${day(i.failedDate!)} and is unpaid.`
          : `Invoice ${i.number} is ${plural(daysBetween(i.dueDate, b.asOf), "day")} past due.`,
        value: 1,
        periodEnd: b.asOf,
        sources: [{ sourceType: "Invoice", sourceId: i.id }],
      },
    };
  }
  const recent = known.filter((i) => i.dueDate >= from && i.dueDate <= b.asOf);
  const recovered = recent
    .filter((i) => paid(i) && daysBetween(i.dueDate, i.paidDate!) > grace)
    .sort((x, y) => (x.paidDate! > y.paidDate! ? -1 : 1))[0];
  if (recovered)
    return {
      score: 70,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: `Invoice ${recovered.number} was paid ${plural(daysBetween(recovered.dueDate, recovered.paidDate!), "day")} late (${day(recovered.paidDate!)}).`,
        value: 0,
        periodStart: from,
        periodEnd: b.asOf,
        sources: [{ sourceType: "Invoice", sourceId: recovered.id }],
      },
    };
  return {
    score: 100,
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: recent.length
        ? `All invoices in the last 90 days were paid on time (${recent.length}).`
        : "No invoices were due in the last 90 days.",
      value: 0,
      periodStart: from,
      periodEnd: b.asOf,
      sources: recent.length
        ? recent.map((i) => ({ sourceType: "Invoice", sourceId: i.id }))
        : [{ sourceType: "Invoice", accountId: b.accountId, from, to: b.asOf }],
    },
  };
}

function seatTrend(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "seat_trend";
  const I = "seats_in_use_trend_90d";
  const rows = (b.usage ?? []).filter((u) => u.seatsUsed !== null);
  const yesterday = addDays(b.asOf, -1);
  const now = rows.filter((u) => u.date <= yesterday).at(-1);
  const then = rows.filter((u) => u.date <= addDays(b.asOf, -91)).at(-1);
  if (!now || !then || now.date < addDays(yesterday, -env.params.usageStaleDays))
    return missing(C, I, "No seat usage data.");
  if (!then.seatsUsed) return missing(C, I, "No seats in use 90 days ago to compare with.");
  const ratio = now.seatsUsed! / then.seatsUsed;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message:
        now.seatsUsed === then.seatsUsed
          ? `Seats in use held at ${now.seatsUsed} over 90 days.`
          : `Seats in use went from ${then.seatsUsed} to ${now.seatsUsed} over 90 days.`,
      value: now.seatsUsed,
      baseline: then.seatsUsed,
      delta: now.seatsUsed! - then.seatsUsed,
      periodStart: then.date,
      periodEnd: now.date,
      sources: [
        { sourceType: "UsageDaily", sourceId: then.id },
        { sourceType: "UsageDaily", sourceId: now.id },
      ],
    },
  };
}

function contraction12m(b: AccountBundle): ComponentResult {
  const C = "contraction_12m";
  const I = "contraction_12m";
  const events = b.revenueEvents.filter((e) => e.effectiveDate <= b.asOf);
  if (events.length === 0) return missing(C, I, "No contract on file.");
  const from = addDays(b.asOf, -364);
  const sized = events
    .filter((e) => e.type === "CONTRACTION" && e.effectiveDate >= from)
    .map((e) => {
      const before = events
        .filter((x) => x.effectiveDate < e.effectiveDate)
        .reduce((s, x) => s + x.deltaArrMinor, 0);
      return { e, share: before > 0 ? Math.abs(e.deltaArrMinor) / before : 1 };
    })
    .sort((x, y) => y.share - x.share);
  const worst = sized[0];
  if (!worst)
    return {
      score: 100,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: "No contraction in the last 12 months.",
        value: 0,
        periodStart: from,
        periodEnd: b.asOf,
        sources: [{ sourceType: "RevenueEvent", accountId: b.accountId, from, to: b.asOf }],
      },
    };
  return {
    score: worst.share >= 0.3 ? 0 : 40,
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `ARR contracted by ${pct(worst.share)} on ${day(worst.e.effectiveDate)}.`,
      value: round4(worst.share),
      periodStart: from,
      periodEnd: b.asOf,
      sources: [{ sourceType: "RevenueEvent", sourceId: worst.e.id }],
    },
  };
}

export const COMMERCIAL: PillarComponents = {
  invoices_90d: invoices90d,
  seat_trend: seatTrend,
  contraction_12m: contraction12m,
  renewal_plan: () =>
    missing("renewal_plan", "renewal_without_plan", "Renewal plans are not tracked yet."),
};
