import { describe, expect, it } from "vitest";
import {
  BATCH_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  estimateRunCostUsd,
  PRICING_LABEL,
  TIER_PRICE_USD_PER_MTOK,
} from "../ai-pricing";

const run = (over: Partial<Parameters<typeof estimateRunCostUsd>[0]> = {}) => ({
  modelTier: "fast",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  planningInputTokens: 0,
  planningOutputTokens: 0,
  batched: false,
  ...over,
});

describe("AI cost estimate (token counts × tier prices from config)", () => {
  it("prices come from config: fast is Haiku 4.5, deep is Sonnet", () => {
    expect(TIER_PRICE_USD_PER_MTOK.fast).toEqual({ input: 1, output: 5 });
    expect(TIER_PRICE_USD_PER_MTOK.deep).toEqual({ input: 3, output: 15 });
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25);
    expect(BATCH_MULTIPLIER).toBe(0.5);
  });

  it("multiplies tokens by the tier's per-million prices", () => {
    expect(estimateRunCostUsd(run({ inputTokens: 1_000_000 }))).toBeCloseTo(1, 6);
    expect(estimateRunCostUsd(run({ outputTokens: 1_000_000 }))).toBeCloseTo(5, 6);
    expect(
      estimateRunCostUsd(
        run({ modelTier: "deep", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ),
    ).toBeCloseTo(18, 6);
  });

  it("prices cache reads at a tenth and cache writes at 1.25× the input price", () => {
    expect(estimateRunCostUsd(run({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.1, 6);
    expect(estimateRunCostUsd(run({ cacheCreationTokens: 1_000_000 }))).toBeCloseTo(1.25, 6);
  });

  it("halves everything for a run that went through the Batch API", () => {
    const base = run({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(estimateRunCostUsd({ ...base, batched: true })).toBeCloseTo(
      estimateRunCostUsd(base) * 0.5,
      6,
    );
  });

  it("prices Ask AI's planning tokens at the fast tier (where planning runs), not at the run's deep tier", () => {
    expect(
      estimateRunCostUsd(run({ modelTier: "deep", planningInputTokens: 1_000_000 })),
    ).toBeCloseTo(1, 6);
    expect(
      estimateRunCostUsd(run({ modelTier: "deep", planningOutputTokens: 1_000_000 })),
    ).toBeCloseTo(5, 6);
  });

  it("an unknown tier is priced as the dearest known tier, never as free", () => {
    expect(estimateRunCostUsd(run({ modelTier: "mystery", inputTokens: 1_000_000 }))).toBeCloseTo(
      3,
      6,
    );
  });

  it("is labelled an estimate", () => {
    expect(PRICING_LABEL).toMatch(/estimate/i);
    expect(PRICING_LABEL).toMatch(/not an invoice/i);
  });
});
