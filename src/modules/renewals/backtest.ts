import { addDays, type CalendarDate } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import {
  labelledOutcomes,
  modelConfigOf,
  scoreAsOf,
  type LabelledOutcome,
} from "@/modules/health/service";
import { riskSignalsAsOf } from "@/modules/signals/service";
import { calibrate, chooseModel, type Calibration, type Sample } from "./calibration";
import { confidence } from "./confidence";
import { inputFromBundle } from "./inputs";
import { confidenceConfig, FACTOR_MODEL, type ConfidenceConfig } from "./schemas";

/**
 * The renewal-confidence back-test (M7 rule 2). The seeded history holds known churn and renewal
 * outcomes (the same labelled set the M3 health back-test uses). For each one, the likelihood is
 * recomputed as of 90, 60 and 30 days before the outcome from a bundle cut to that date — health
 * from `scoreAsOf` under the default model, trend from the score 30 days earlier, signals from the
 * rules evaluated on that bundle, champion, invoices and usage from records dated on or before
 * it. Nothing after the as-of date is read, a renewal plan's existence is unknowable (so the
 * notice factor is null), and promises are null until M9.
 *
 * Two models are scored on the same points: the factor model (every factor, default weights) and
 * the simple one (health band + notice only: the notice factor is null here, so in effect the band).
 * The simple one ships unless the factor model beats it on pooled Brier score by more than
 * BRIER_MARGIN (D-118). Calibration is reported by band and score bucket, never tuned.
 */
export const HORIZONS = [90, 60, 30] as const;

/** The simple model: the same base and the health band's points; every other weight is zero. */
export const SIMPLE_CONFIG: ConfidenceConfig = confidenceConfig.parse({
  healthTrend: { fallingBy10: 0, fallingBy5: 0, risingBy5: 0 },
  signals: { criticalEach: 0, warnEach: 0, maxPenalty: 0 },
  champion: { active: 0, silent: 0, gone: 0 },
  invoices: { failedUnpaid: 0, lateUnpaid: 0, paidLate: 0, clean: 0 },
  usage: { atLeast90: 0, atLeast70: 0, atLeast50: 0, below50: 0 },
});

export interface BacktestRow {
  name: string;
  outcome: "RENEWED" | "CHURNED";
  outcomeDate: CalendarDate;
  horizonDays: number;
  asOf: CalendarDate;
  scorable: boolean;
  why?: string;
  factor?: { confidence: number; band: "HIGH" | "MEDIUM" | "LOW" };
  simple?: { confidence: number; band: "HIGH" | "MEDIUM" | "LOW" };
  /** Factor key → points (null = no data), for the factor model. */
  points?: Record<string, number | null>;
}

export interface RenewalBacktest {
  asOf: CalendarDate;
  outcomes: { churns: number; renewals: number };
  horizons: Record<string, { factor: Calibration; simple: Calibration }>;
  pooled: { factor: Calibration; simple: Calibration };
  /** How many scored points each factor had data for. */
  factorCoverage: Record<string, number>;
  shipped: "factor" | "simple";
  rows: BacktestRow[];
}

const BATCH = 4;

export async function runRenewalBacktest(
  ctx: TenantContext,
  today: CalendarDate,
  cfg: ConfidenceConfig = FACTOR_MODEL,
): Promise<RenewalBacktest> {
  const { outcomes } = await labelledOutcomes(ctx, today);
  // The default model (v1), not whatever is active, so the result is reproducible (as in M3).
  const model = await scopedDb(ctx).healthModel.findFirstOrThrow({
    where: { proposedBy: "SYSTEM_DEFAULT" },
  });
  const healthModel = { id: model.id, config: modelConfigOf(model) };

  const wanted = new Map<CalendarDate, Set<string>>();
  const want = (date: CalendarDate, id: string) =>
    wanted.set(date, (wanted.get(date) ?? new Set<string>()).add(id));
  for (const o of outcomes)
    for (const h of HORIZONS) {
      const asOf = addDays(o.date, -h);
      want(asOf, o.accountId);
      want(addDays(asOf, -30), o.accountId);
    }
  const scored = new Map<CalendarDate, Awaited<ReturnType<typeof scoreAsOf>>>();
  const dates = [...wanted.keys()].sort();
  for (let i = 0; i < dates.length; i += BATCH)
    await Promise.all(
      dates.slice(i, i + BATCH).map(async (d) => {
        scored.set(d, await scoreAsOf(ctx, [...wanted.get(d)!], d, healthModel));
      }),
    );

  const rows: BacktestRow[] = [];
  const sorted = [...outcomes].sort((a, b) =>
    `${a.type}|${a.date}|${a.name}` < `${b.type}|${b.date}|${b.name}` ? -1 : 1,
  );
  for (const o of sorted) for (const h of HORIZONS) rows.push(scoreOne(o, h, scored, cfg));

  const samples = (key: "factor" | "simple", horizon?: number): Sample[] =>
    rows
      .filter((r) => r.scorable && (horizon === undefined || r.horizonDays === horizon))
      .map((r) => ({ ...r[key]!, renewed: r.outcome === "RENEWED" }));
  const horizons: RenewalBacktest["horizons"] = {};
  for (const h of HORIZONS)
    horizons[String(h)] = {
      factor: calibrate(samples("factor", h)),
      simple: calibrate(samples("simple", h)),
    };
  const pooled = { factor: calibrate(samples("factor")), simple: calibrate(samples("simple")) };
  const factorCoverage: Record<string, number> = {};
  for (const r of rows)
    for (const [k, v] of Object.entries(r.points ?? {}))
      if (v !== null) factorCoverage[k] = (factorCoverage[k] ?? 0) + 1;
  return {
    asOf: today,
    outcomes: {
      churns: outcomes.filter((o) => o.type === "CHURN").length,
      renewals: outcomes.filter((o) => o.type === "RENEWAL").length,
    },
    horizons,
    pooled,
    factorCoverage,
    shipped: chooseModel(pooled.factor.brier, pooled.simple.brier),
    rows,
  };
}

function scoreOne(
  o: LabelledOutcome,
  horizonDays: number,
  scored: Map<CalendarDate, Awaited<ReturnType<typeof scoreAsOf>>>,
  cfg: ConfidenceConfig,
): BacktestRow {
  const asOf = addDays(o.date, -horizonDays);
  const base = {
    name: o.name,
    outcome: o.type === "RENEWAL" ? ("RENEWED" as const) : ("CHURNED" as const),
    outcomeDate: o.date,
    horizonDays,
    asOf,
  };
  const now = scored.get(asOf)?.get(o.accountId);
  if (!now?.bundle.contract)
    return { ...base, scorable: false, why: "no contract in force on that date" };
  const earlier = scored.get(addDays(asOf, -30))?.get(o.accountId);
  const b = now.bundle;
  const trend30 =
    now.score.overall !== null && earlier?.score.overall != null
      ? now.score.overall - earlier.score.overall
      : null;
  const input = inputFromBundle({
    bundle: b,
    renewal: {
      contractId: b.contract!.id,
      renewalDate: b.contract!.renewalDate ?? o.date,
      noticeDeadline: null,
    },
    health: {
      band: now.score.riskLevel,
      overall: now.score.overall,
      sources: [{ sourceType: "Account", sourceId: o.accountId }],
    },
    trend30,
    signals: riskSignalsAsOf(b).map((s) => ({
      key: s.key,
      severity: s.severity,
      title: s.title,
      sources: s.evidence.map(({ sourceType, sourceId, accountId, from, to }) => ({
        sourceType,
        sourceId,
        accountId,
        from,
        to,
      })),
    })),
    plan: null, // whether a plan existed on that date is not knowable
    cfg,
  });
  const factor = confidence(input, cfg);
  const simple = confidence(input, SIMPLE_CONFIG);
  return {
    ...base,
    scorable: true,
    factor: { confidence: factor.confidence, band: factor.band },
    simple: { confidence: simple.confidence, band: simple.band },
    points: Object.fromEntries(factor.factors.map((f) => [f.key, f.points])),
  };
}
