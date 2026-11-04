import { daysBetween, type CalendarDate } from "@/lib/dates";
import type { ConfidenceConfig } from "./schemas";

/**
 * Renewal confidence (M7 §2, D-75): a deterministic likelihood from records. No model, no clock,
 * no database: the same input and settings always give the same figure. Each factor adds or takes
 * off signed points with a plain-language reason and the records behind it. A factor with no data
 * is `null`: it is listed, it adds nothing, and it never lowers the figure (Rule 4). The result
 * is clamped to 0–100 and banded HIGH / MEDIUM / LOW by the workspace's lines.
 *
 * Inputs are built by `inputs.ts` — from live records for tonight's radar, or cut to a past date
 * for the back-test — so this function cannot tell the two apart, and cannot look ahead.
 */
export interface Source {
  sourceType: string;
  sourceId?: string;
  accountId?: string;
  from?: CalendarDate;
  to?: CalendarDate;
}

export type HealthBand = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";

export interface ConfidenceInput {
  asOf: CalendarDate;
  accountId: string;
  contractId: string;
  renewalDate: CalendarDate;
  /** renewalDate minus the notice period; null when no notice period is on file. */
  noticeDeadline: CalendarDate | null;
  health: {
    band: HealthBand;
    overall: number | null;
    /** Overall now minus overall 30 days ago; null when there is no earlier score. */
    trend30: number | null;
    sources: Source[];
  } | null;
  /** Open WARN/CRITICAL risk signals (renewal windows and invoice signals excluded); null = unknown. */
  signals: Array<{
    key: string;
    severity: "WARN" | "CRITICAL";
    title: string;
    sources: Source[];
  }> | null;
  /** null = no champion on record. */
  champion: {
    state: "ACTIVE" | "SILENT" | "GONE";
    name: string;
    silentDays: number | null;
    sources: Source[];
  } | null;
  /** null = no invoice data known. */
  invoices: Array<{
    id: string;
    number: string;
    issuedDate: CalendarDate;
    dueDate: CalendarDate;
    paidDate: CalendarDate | null;
    failedDate: CalendarDate | null;
    isVoid: boolean;
  }> | null;
  /** null = whether a renewal plan existed is not knowable (the back-test). */
  plan: { exists: boolean; sources: Source[] } | null;
  /** null = no usage or no normal to compare with. */
  usage: { current: number | null; normal: number | null; sources: Source[] } | null;
}

export interface Factor {
  key: string;
  label: string;
  /** Signed points; null = no data, excluded from the total. */
  points: number | null;
  reason: string;
  sources: Source[];
}

export interface ConfidenceResult {
  confidence: number;
  band: "HIGH" | "MEDIUM" | "LOW";
  asOf: CalendarDate;
  factors: Factor[];
  /** The reasons of the factors with no data, in plain words. */
  missing: string[];
}

const BAND_WORDS: Record<HealthBand, string> = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At Risk",
  INSUFFICIENT_DATA: "not scored yet",
};
const round1 = (x: number) => Math.round(x * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function confidence(input: ConfidenceInput, cfg: ConfidenceConfig): ConfidenceResult {
  const contract: Source = { sourceType: "Contract", sourceId: input.contractId };
  const factor = (
    key: string,
    label: string,
    points: number | null,
    reason: string,
    sources: Source[],
  ): Factor => ({
    key,
    label,
    points,
    reason,
    sources: sources.length > 0 ? sources : [contract],
  });
  const factors: Factor[] = [
    healthBand(input, cfg, factor),
    healthTrend(input, cfg, factor),
    signalsFactor(input, cfg, factor),
    championFactor(input, cfg, factor),
    factor(
      "promises",
      "Promises",
      null,
      "Promise tracking starts in M9, so late promises are not counted",
      [contract],
    ),
    invoicesFactor(input, cfg, factor),
    noticeFactor(input, cfg, factor),
    usageFactor(input, cfg, factor),
  ];
  const total = factors.reduce((sum, f) => sum + (f.points ?? 0), cfg.base);
  const clamped = Math.max(0, Math.min(100, Math.round(total)));
  return {
    confidence: clamped,
    band:
      clamped >= cfg.bands.highAtLeast
        ? "HIGH"
        : clamped >= cfg.bands.mediumAtLeast
          ? "MEDIUM"
          : "LOW",
    asOf: input.asOf,
    factors,
    missing: factors.filter((f) => f.points === null).map((f) => f.reason),
  };
}

type Make = (
  key: string,
  label: string,
  points: number | null,
  reason: string,
  sources: Source[],
) => Factor;

function healthBand(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const h = i.health;
  if (!h || h.band === "INSUFFICIENT_DATA")
    return make("health_band", "Health", null, "Health has not been scored yet", h?.sources ?? []);
  const score = h.overall === null ? "" : ` (score ${round1(h.overall)})`;
  return make(
    "health_band",
    "Health",
    c.healthBand[h.band],
    `Health is ${BAND_WORDS[h.band]}${score}`,
    h.sources,
  );
}

function healthTrend(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const t = i.health?.trend30 ?? null;
  const sources = i.health?.sources ?? [];
  if (t === null)
    return make(
      "health_trend",
      "Health trend",
      null,
      "There is no health score from 30 days ago to compare",
      sources,
    );
  const words = `Health ${t < 0 ? "fell" : "rose"} ${round1(Math.abs(t))} points in the last 30 days`;
  if (t <= -10)
    return make("health_trend", "Health trend", c.healthTrend.fallingBy10, words, sources);
  if (t <= -5)
    return make("health_trend", "Health trend", c.healthTrend.fallingBy5, words, sources);
  if (t >= 5) return make("health_trend", "Health trend", c.healthTrend.risingBy5, words, sources);
  return make(
    "health_trend",
    "Health trend",
    0,
    "Health is about where it was 30 days ago",
    sources,
  );
}

function signalsFactor(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  if (i.signals === null)
    return make("signals", "Open risk signals", null, "Risk signals have not been evaluated", []);
  if (i.signals.length === 0)
    return make("signals", "Open risk signals", 0, "No risk signals are open", [
      { sourceType: "Account", sourceId: i.accountId },
    ]);
  const raw = i.signals.reduce(
    (sum, s) => sum + (s.severity === "CRITICAL" ? c.signals.criticalEach : c.signals.warnEach),
    0,
  );
  const points = Math.max(c.signals.maxPenalty, raw);
  const critical = i.signals.filter((s) => s.severity === "CRITICAL").length;
  return make(
    "signals",
    "Open risk signals",
    points,
    `${plural(i.signals.length, "risk signal")} open${critical ? ` (${critical} critical)` : ""}: ${i.signals.map((s) => s.title).join("; ")}`,
    i.signals.flatMap((s) => s.sources),
  );
}

function championFactor(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const ch = i.champion;
  if (!ch)
    return make("champion", "Champion", null, "No champion is on record for this account", []);
  if (ch.state === "ACTIVE")
    return make(
      "champion",
      "Champion",
      c.champion.active,
      `The champion, ${ch.name}, is in touch`,
      ch.sources,
    );
  if (ch.state === "SILENT")
    return make(
      "champion",
      "Champion",
      c.champion.silent,
      `The champion, ${ch.name}, has been silent for ${plural(ch.silentDays ?? c.champion.silentAfterDays, "day")}`,
      ch.sources,
    );
  return make(
    "champion",
    "Champion",
    c.champion.gone,
    `The champion, ${ch.name}, has left or cannot be reached`,
    ch.sources,
  );
}

function invoicesFactor(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const known = (i.invoices ?? []).filter((x) => !x.isVoid && x.issuedDate <= i.asOf);
  if (known.length === 0)
    return make(
      "invoices",
      "Invoices",
      null,
      "There are no invoices on file to judge payment by",
      [],
    );
  const src = (x: (typeof known)[number]): Source[] => [{ sourceType: "Invoice", sourceId: x.id }];
  const failed = known.find(
    (x) => x.failedDate !== null && x.failedDate <= i.asOf && x.paidDate === null,
  );
  if (failed)
    return make(
      "invoices",
      "Invoices",
      c.invoices.failedUnpaid,
      `Invoice ${failed.number} had a failed payment and is unpaid`,
      src(failed),
    );
  const late = known.find(
    (x) => x.paidDate === null && daysBetween(x.dueDate, i.asOf) > c.invoices.lateAfterDays,
  );
  if (late)
    return make(
      "invoices",
      "Invoices",
      c.invoices.lateUnpaid,
      `Invoice ${late.number} is unpaid ${plural(daysBetween(late.dueDate, i.asOf), "day")} past its due date`,
      src(late),
    );
  const paidLate = known
    .filter(
      (x) =>
        x.paidDate !== null &&
        x.paidDate <= i.asOf &&
        daysBetween(x.dueDate, x.paidDate) > c.invoices.paidLateAfterDays &&
        daysBetween(x.paidDate, i.asOf) <= c.invoices.lookbackDays,
    )
    .sort((a, b) => (a.paidDate! < b.paidDate! ? 1 : -1))[0];
  if (paidLate)
    return make(
      "invoices",
      "Invoices",
      c.invoices.paidLate,
      `Invoice ${paidLate.number} was paid ${plural(daysBetween(paidLate.dueDate, paidLate.paidDate!), "day")} late`,
      src(paidLate),
    );
  return make(
    "invoices",
    "Invoices",
    c.invoices.clean,
    "Invoices have been paid on time",
    known.slice(-3).flatMap(src),
  );
}

function noticeFactor(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const contract: Source[] = [{ sourceType: "Contract", sourceId: i.contractId }];
  if (!i.noticeDeadline)
    return make(
      "notice",
      "Notice deadline",
      null,
      "No notice period is on file, so the notice deadline is unknown",
      contract,
    );
  if (!i.plan)
    return make(
      "notice",
      "Notice deadline",
      null,
      "Whether a renewal plan existed is not known for this date",
      contract,
    );
  const days = daysBetween(i.asOf, i.noticeDeadline);
  const sources = [...contract, ...i.plan.sources];
  if (i.plan.exists)
    return make(
      "notice",
      "Notice deadline",
      c.notice.hasPlan,
      "A renewal plan is in place",
      sources,
    );
  if (days <= c.notice.noPlanWithinDays)
    return make(
      "notice",
      "Notice deadline",
      c.notice.noPlan,
      days >= 0
        ? `The notice deadline is in ${plural(days, "day")} and there is no renewal plan`
        : `The notice deadline passed ${plural(-days, "day")} ago and there is no renewal plan`,
      sources,
    );
  return make(
    "notice",
    "Notice deadline",
    0,
    `The notice deadline is ${plural(days, "day")} away and there is no renewal plan yet`,
    sources,
  );
}

function usageFactor(i: ConfidenceInput, c: ConfidenceConfig, make: Make): Factor {
  const u = i.usage;
  if (!u || u.current === null || u.normal === null || u.normal <= 0)
    return make(
      "usage",
      "Usage",
      null,
      "There is no usage history to compare with this account's normal",
      u?.sources ?? [],
    );
  const ratio = u.current / u.normal;
  const pct = `${Math.round(ratio * 100)}%`;
  const reason = `Weekday use is ${pct} of this account's normal`;
  const points =
    ratio >= 0.9
      ? c.usage.atLeast90
      : ratio >= 0.7
        ? c.usage.atLeast70
        : ratio >= 0.5
          ? c.usage.atLeast50
          : c.usage.below50;
  return make("usage", "Usage", points, reason, u.sources);
}
