import { addDays, daysBetween, type CalendarDate } from "@/lib/dates";
import { count, missing, money, sumKnown, withQuery } from "./figures";
import type { Figure, ReportContent } from "./types";

/**
 * Portfolio health trend (spec §5 Reports). Bands come from the stored live health snapshots, the
 * same records the Health screen reads (back-test replays never enter, D-158: the service loads
 * only `liveSnapshotWhere` rows). "Now" mirrors `healthOverview`: each account's current
 * snapshot under the active model. Unscored accounts are counted apart, never as a band (Rule 4).
 */
export type Band = "AT_RISK" | "WATCH" | "HEALTHY" | "INSUFFICIENT_DATA";
const BAND_LABEL: Record<Band, string> = {
  AT_RISK: "At Risk",
  WATCH: "Watch",
  HEALTHY: "Healthy",
  INSUFFICIENT_DATA: "Not enough data",
};
const RANK: Partial<Record<Band, number>> = { AT_RISK: 0, WATCH: 1, HEALTHY: 2 };
const TREND_BANDS: Band[] = ["AT_RISK", "WATCH", "HEALTHY"];

export interface HealthTrendInput {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  baseCurrency: string;
  /** List-screen query (tier/owner/segment) carried into links. */
  query: string;
  accounts: Array<{
    id: string;
    arrMinor: bigint | null;
    currency: string | null;
    /** The account's current snapshot under the active model; null = not scored. */
    currentSnapshotId: string | null;
    currentRisk: Band | null;
  }>;
  /** Live snapshots only, any order. */
  snapshots: Array<{ id: string; accountId: string; asOf: CalendarDate; riskLevel: Band }>;
}

/** Weekly points from the start, always ending on the end date. */
export function trendPoints(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 7)) out.push(d);
  if (out.at(-1) !== end) out.push(end);
  return out;
}

export function portfolioHealthTrend(i: HealthTrendInput): ReportContent {
  const notes: string[] = [];
  const empty = i.accounts.length === 0;
  const noAccounts = "No accounts in scope for this report.";
  const accountRows = (ids: string[]) => ids.map((id) => ({ id }));
  const bandHref = (b: Band) => withQuery("/accounts", `health=${b}`, i.query);

  // Now
  const now: Figure[] = [];
  const scored = i.accounts.filter((a) => a.currentSnapshotId && a.currentRisk);
  for (const b of Object.keys(BAND_LABEL) as Band[]) {
    const label = `${BAND_LABEL[b]} now`;
    if (empty) {
      now.push(missing(label, "count", "HealthScoreSnapshot", noAccounts));
      continue;
    }
    const inBand = scored.filter((a) => a.currentRisk === b);
    now.push(
      count(
        label,
        "HealthScoreSnapshot",
        inBand.map((a) => ({ id: a.currentSnapshotId!, accountId: a.id })),
        bandHref(b),
      ),
    );
  }
  const unscored = i.accounts.filter((a) => !a.currentSnapshotId);
  now.push(
    empty
      ? missing("Not scored yet", "count", "Account", noAccounts)
      : count("Not scored yet", "Account", accountRows(unscored.map((a) => a.id))),
  );

  // ARR in At Risk (money): only known amounts in the base currency; the rest listed apart.
  const atRisk = scored.filter((a) => a.currentRisk === "AT_RISK");
  const inBase = atRisk.filter((a) => a.currency === i.baseCurrency);
  const noArr = atRisk.filter((a) => a.arrMinor === null || a.currency === null);
  const otherCur = atRisk.filter((a) => a.currency !== null && a.currency !== i.baseCurrency);
  const arrFigures: Figure[] = [
    empty
      ? missing("ARR in At Risk now", "money", "Account", noAccounts)
      : money(
          "ARR in At Risk now",
          sumKnown(inBase, (a) => a.arrMinor),
          i.baseCurrency,
          "Account",
          accountRows(inBase.filter((a) => a.arrMinor !== null).map((a) => a.id)),
          atRisk.length === 0
            ? "No account is At Risk."
            : "No ARR on file for the At Risk accounts.",
          bandHref("AT_RISK"),
        ),
    count("At Risk accounts with no ARR on file", "Account", accountRows(noArr.map((a) => a.id))),
  ];
  if (otherCur.length)
    arrFigures.push(
      count(
        "At Risk accounts in another currency (not added up)",
        "Account",
        accountRows(otherCur.map((a) => a.id)),
      ),
    );

  // Trend: the latest snapshot on or before each point, per account.
  const byAccount = new Map<string, HealthTrendInput["snapshots"]>();
  for (const s of i.snapshots)
    byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  for (const list of byAccount.values()) list.sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
  const asOfPoint = (accountId: string, day: CalendarDate) =>
    (byAccount.get(accountId) ?? []).filter((s) => s.asOf <= day).at(-1) ?? null;

  const points = trendPoints(i.periodStart, i.periodEnd);
  const accountIds = new Set(i.accounts.map((a) => a.id));
  const series: Figure[] = [];
  const placed = new Map<CalendarDate, Map<string, NonNullable<ReturnType<typeof asOfPoint>>>>();
  for (const day of points) {
    const here = new Map<string, NonNullable<ReturnType<typeof asOfPoint>>>();
    for (const id of accountIds) {
      const s = asOfPoint(id, day);
      if (s) here.set(id, s);
    }
    placed.set(day, here);
    for (const b of TREND_BANDS) {
      const label = `${BAND_LABEL[b]} on ${day}`;
      if (empty) series.push(missing(label, "count", "HealthScoreSnapshot", noAccounts));
      else if (here.size === 0)
        series.push(
          missing(label, "count", "HealthScoreSnapshot", "No health history before this date."),
        );
      else
        series.push(
          count(
            label,
            "HealthScoreSnapshot",
            [...here.values()]
              .filter((s) => s.riskLevel === b)
              .map((s) => ({ id: s.id, accountId: s.accountId })),
          ),
        );
    }
  }

  // Movement between the first and last day that both have a band.
  const first = placed.get(points[0]!)!;
  const last = placed.get(points.at(-1)!)!;
  const worse: string[] = [];
  const better: string[] = [];
  for (const [id, was] of first) {
    const is = last.get(id);
    const a = RANK[was.riskLevel];
    const b = is ? RANK[is.riskLevel] : undefined;
    if (a === undefined || b === undefined) continue;
    if (b < a) worse.push(id);
    if (b > a) better.push(id);
  }
  const span = daysBetween(i.periodStart, i.periodEnd);
  const noHistory = "No account has a band on both the first and the last day.";
  const movement: Figure[] =
    first.size === 0 || empty
      ? [
          missing("Moved to a worse band", "count", "Account", empty ? noAccounts : noHistory),
          missing("Moved to a better band", "count", "Account", empty ? noAccounts : noHistory),
        ]
      : [
          count("Moved to a worse band", "Account", accountRows(worse)),
          count("Moved to a better band", "Account", accountRows(better)),
        ];
  if (span < 7) notes.push("The period is shorter than a week, so the trend has two points.");

  return {
    notes,
    sections: [
      { title: "Now", figures: now },
      { title: "ARR in At Risk", figures: arrFigures },
      {
        title: `Accounts per band, ${i.periodStart} to ${i.periodEnd}`,
        note: "Weekly points; each account counted in the band of its latest health snapshot on or before that day.",
        figures: series,
      },
      { title: "Movement over the period", figures: movement },
    ],
  };
}
