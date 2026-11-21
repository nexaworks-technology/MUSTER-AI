import type { CalendarDate } from "@/lib/dates";
import { forecast, type ForecastRenewal } from "@/modules/renewals/service";
import { count, missing, money, percent, sumKnown, withQuery } from "./figures";
import type { Figure, ReportContent } from "./types";

/**
 * Renewal outcomes (spec §6L, M7). What happened is read from RenewalOutcome rows; what was
 * forecast is the forecast frozen on each row at the time (never the live renewal), so the
 * comparison cannot drift. Corrections replace the row they supersede. The "upcoming" block runs
 * `forecast()`, the function behind the Renewals screen's forecast, over the same open renewals.
 */
export interface RenewalOutcomesInput {
  baseCurrency: string;
  query: string;
  upcomingDays: number;
  outcomes: Array<{
    id: string;
    accountId: string;
    renewalId: string;
    result: "RENEWED" | "CHURNED";
    occurredOn: CalendarDate;
    outcomeArrMinor: bigint | null;
    currency: string | null;
    forecastBand: "HIGH" | "MEDIUM" | "LOW";
    forecastArrAtRiskMinor: bigint | null;
    supersedesId: string | null;
  }>;
  /** Open renewals due within `upcomingDays`, and any still open after their date (`overdue`). */
  upcoming: Array<ForecastRenewal & { accountId: string; overdue?: boolean }>;
}

const BAND_WORD = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" } as const;

export function renewalOutcomesReport(i: RenewalOutcomesInput): ReportContent {
  const superseded = new Set(i.outcomes.flatMap((o) => (o.supersedesId ? [o.supersedesId] : [])));
  const decided = i.outcomes.filter((o) => !superseded.has(o.id));
  const row = (o: { id: string; accountId: string }) => ({ id: o.id, accountId: o.accountId });
  const renewed = decided.filter((o) => o.result === "RENEWED");
  const churned = decided.filter((o) => o.result === "CHURNED");
  const base = (o: { currency: string | null }) => o.currency === i.baseCurrency;
  const otherCur = decided.filter((o) => o.currency !== null && o.currency !== i.baseCurrency);

  const renewedKnown = renewed.filter((o) => base(o) && o.outcomeArrMinor !== null);
  const renewedNoValue = renewed.filter((o) => o.outcomeArrMinor === null);
  const churnedKnown = churned.filter((o) => base(o) && o.forecastArrAtRiskMinor !== null);
  const none = "No renewal outcome recorded in this period.";
  const href = withQuery("/renewals", i.query);

  const outcomes: Figure[] = [
    count("Renewed", "RenewalOutcome", renewed.map(row)),
    count("Churned", "RenewalOutcome", churned.map(row)),
    percent("Renewal rate", "RenewalOutcome", renewed.map(row), decided.map(row), none),
    renewedKnown.length || renewed.length === 0
      ? money(
          "ARR renewed",
          sumKnown(renewedKnown, (o) => o.outcomeArrMinor),
          i.baseCurrency,
          "RenewalOutcome",
          renewedKnown.map(row),
          renewed.length ? "No renewed contract value on file." : none,
        )
      : missing("ARR renewed", "money", "RenewalOutcome", "No renewed contract value on file."),
    count("Renewed with no contract value on file", "RenewalOutcome", renewedNoValue.map(row)),
    churned.length === 0
      ? missing("ARR churned", "money", "RenewalOutcome", "No renewal churned in this period.")
      : money(
          "ARR churned",
          sumKnown(churnedKnown, (o) => o.forecastArrAtRiskMinor),
          i.baseCurrency,
          "RenewalOutcome",
          churnedKnown.map(row),
          "No ARR at risk was on file when these were forecast.",
        ),
    count("Outcomes in another currency (not added up)", "RenewalOutcome", otherCur.map(row)),
  ];

  const high = decided.filter((o) => o.forecastBand === "HIGH");
  const low = decided.filter((o) => o.forecastBand === "LOW");
  const calls: Figure[] = [
    percent(
      "Renewed, of those forecast High",
      "RenewalOutcome",
      high.filter((o) => o.result === "RENEWED").map(row),
      high.map(row),
      "No renewal in this period was forecast High confidence.",
    ),
    percent(
      "Churned, of those forecast Low",
      "RenewalOutcome",
      low.filter((o) => o.result === "CHURNED").map(row),
      low.map(row),
      "No renewal in this period was forecast Low confidence.",
    ),
  ];

  const f = forecast(i.upcoming, i.baseCurrency);
  const idsOf = (ids: string[]) =>
    ids.map((id) => ({ id, accountId: i.upcoming.find((r) => r.id === id)?.accountId }));
  const upcoming: Figure[] = [
    count(
      `Renewals due in the next ${i.upcomingDays} days`,
      "Renewal",
      idsOf(i.upcoming.filter((r) => !r.overdue).map((r) => r.id)),
      withQuery("/renewals", `days=${i.upcomingDays}`, i.query),
    ),
    count(
      "Overdue renewals, still open after their date",
      "Renewal",
      idsOf(i.upcoming.filter((r) => r.overdue).map((r) => r.id)),
      withQuery("/renewals", `days=${i.upcomingDays}`, i.query),
    ),
    ...(["HIGH", "MEDIUM", "LOW"] as const).map((b) => {
      const label = `Forecast ARR, ${BAND_WORD[b]} confidence`;
      const bucket = f.byBand[b];
      return bucket.renewalIds.length
        ? money(
            label,
            bucket.arrMinor,
            f.baseCurrency,
            "Renewal",
            idsOf(bucket.renewalIds),
            "",
            href,
          )
        : missing(
            label,
            "money",
            "Renewal",
            `No ${BAND_WORD[b]}-confidence renewal with ARR is due.`,
          );
    }),
    count("Upcoming renewals with no ARR on file", "Renewal", idsOf(f.noArrIds)),
  ];

  return {
    notes: [],
    sections: [
      { title: "What happened", figures: outcomes },
      {
        title: "Against the forecast made before",
        note: "Each outcome carries the forecast frozen when it was recorded.",
        figures: calls,
      },
      { title: "Still to come", figures: upcoming },
    ],
  };
}
