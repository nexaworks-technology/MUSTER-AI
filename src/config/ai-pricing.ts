/**
 * AI price list for the cost ESTIMATE (docs/AI-COST-2026-11-11.md). Prices are USD per million
 * tokens, kept here (never in feature code) and labelled as estimates wherever they are shown.
 * They are Anthropic's published list prices for the models the tiers map to by default
 * (AI_MODEL_FAST = claude-haiku-4-5, AI_MODEL_DEEP = claude-sonnet-4-6). If you point a tier at a
 * different model, or Anthropic changes prices, edit this file: nothing else holds a price.
 */
export const TIER_PRICE_USD_PER_MTOK = {
  fast: { input: 1, output: 5 },
  standard: { input: 3, output: 15 },
  deep: { input: 3, output: 15 },
} as const;

import { jobTier } from "@/lib/ai/routing";

/** Tokens read from the prompt cache cost a tenth of the input price. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Tokens written to the prompt cache (5-minute entries) cost 1.25× the input price. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** The Message Batches API charges half of every price above. */
export const BATCH_MULTIPLIER = 0.5;

export const PRICING_LABEL =
  "Estimate: token counts × list prices from src/config/ai-pricing.ts (Haiku $1 in / $5 out and Sonnet $3 in / $15 out per million tokens; batch −50 %; cache reads −90 %). Not an invoice.";

export interface PricedRun {
  modelTier: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Ask AI's planning calls, priced at the tier planning runs on (fast), not the run's own tier. */
  planningInputTokens: number;
  planningOutputTokens: number;
  /** True when the run went through the Message Batches API. */
  batched: boolean;
}

/** Estimated USD for one run. An unknown tier is priced as the dearest tier, never as free. */
export function estimateRunCostUsd(r: PricedRun): number {
  const price =
    (TIER_PRICE_USD_PER_MTOK as Record<string, { input: number; output: number }>)[r.modelTier] ??
    TIER_PRICE_USD_PER_MTOK.deep;
  const plan = TIER_PRICE_USD_PER_MTOK[jobTier("ask-ai-plan")];
  const usd =
    (r.planningInputTokens * plan.input +
      r.planningOutputTokens * plan.output +
      r.inputTokens * price.input +
      r.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER +
      r.cacheCreationTokens * price.input * CACHE_WRITE_MULTIPLIER +
      r.outputTokens * price.output) /
    1_000_000;
  return r.batched ? usd * BATCH_MULTIPLIER : usd;
}
