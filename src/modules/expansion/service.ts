/** The expansion module's public surface (ARCHITECTURE §2). Other modules import from here only. */
export {
  estimateSeatsOverLimit,
  estimateTierUpgrade,
  perSeatAnnual,
  type Estimate,
  type PricedSubscription,
  type SeatsOverEstimate,
} from "./estimate";
export { whitespace, type Whitespace, type WhitespaceInput } from "./whitespace";
export { loadWhitespace } from "./whitespace.service";
export { EXPANSION_RULES, syncExpansion, type ExpansionSyncCounts } from "./sync.service";
export {
  canWork,
  exportOpportunity,
  ExpansionError,
  getAccountExpansion,
  listOpportunities,
  opportunityInput,
  opportunityQuery,
  STATUS_WORDS,
  STATUSES,
  updateOpportunity,
  type OpportunityRow,
} from "./read.service";
