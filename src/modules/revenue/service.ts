/** The revenue module's public surface (ARCHITECTURE §2). */
export { syncArrChecks, mismatchDetail, type ArrCheckCounts } from "./sync.service";
export {
  arrMismatches,
  waterfall,
  type ArrMismatch,
  type CurrencyWaterfall,
  type Movement,
  type Waterfall,
  type WaterfallEvent,
} from "./waterfall";
export {
  addMonths,
  billingForecast,
  type BillingForecast,
  type BillingMonth,
  type ForecastSubscription,
} from "./billingForecast";
