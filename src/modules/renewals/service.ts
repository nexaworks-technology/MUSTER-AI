/**
 * The renewals module's public surface (ARCHITECTURE §2). Other modules import from here only.
 * The pipeline loads it on use (dynamic import) because the back-test reads the signals module's
 * rules and the signals pipeline calls the nightly sync.
 */
export {
  confidence,
  type ConfidenceInput,
  type ConfidenceResult,
  type Factor,
  type HealthBand,
  type Source,
} from "./confidence";
export { championState, type ChampionState } from "./champion";
export { inputFromBundle, usageAgainstNormal, type RenewalFacts } from "./inputs";
export {
  BRIER_MARGIN,
  calibrate,
  chooseModel,
  SCORE_BUCKETS,
  type Calibration,
  type Sample,
} from "./calibration";
export {
  HORIZONS,
  runRenewalBacktest,
  SIMPLE_CONFIG,
  type BacktestRow,
  type RenewalBacktest,
} from "./backtest";
export {
  CATEGORY_WORDS,
  confidenceConfig,
  DEFAULT_CONFIDENCE,
  FACTOR_MODEL,
  FORECAST_CATEGORIES,
  renewalSettings,
  type ConfidenceConfig,
} from "./schemas";
export { syncRenewals, type SyncCounts } from "./sync.service";
export { renewalTiming } from "./timing";
export {
  forecast,
  disagreement,
  BAND_SUGGESTS,
  type Forecast,
  type ForecastRenewal,
} from "./forecast";
export {
  canCategorise,
  getAccountRenewals,
  listRenewals,
  openRenewalWindow,
  RenewalError,
  setForecastCategory,
  type RenewalRow,
} from "./read.service";
export {
  adoptRenewalPlan,
  PlanAdoptionValidationError,
  type AdoptRenewalPlanInput,
  type PlanStepInput,
} from "./plan-adoption";
