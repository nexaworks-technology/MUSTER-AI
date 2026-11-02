import { DEFAULT_MODEL, type ModelConfig, type Pillar } from "../model";
import type { AccountBundle, ComponentResult, PillarComponents } from "../types";
import { ADOPTION } from "./adoption";
import { COMMERCIAL } from "./commercial";
import { ENGAGEMENT } from "./engagement";
import { RELATIONSHIP } from "./relationship";
import { SUPPORT } from "./support";

/** Sentiment needs text analysis (M9) and surveys (M10). Until then it has no data, never 0. */
const SENTIMENT: PillarComponents = {
  sentiment_share: () => ({
    score: null,
    reason: {
      component: "sentiment_share",
      kind: "MISSING_DATA",
      input: "negative_sentiment_share_90d",
      message: "No sentiment analysis of emails, calls or tickets yet.",
      sources: [],
    },
  }),
  survey_average: () => ({
    score: null,
    reason: {
      component: "survey_average",
      kind: "MISSING_DATA",
      input: "survey_average",
      message: "No survey responses yet.",
      sources: [],
    },
  }),
};

export const COMPONENTS: Record<Pillar, PillarComponents> = {
  ADOPTION,
  ENGAGEMENT,
  SUPPORT,
  RELATIONSHIP,
  COMMERCIAL,
  SENTIMENT,
};

export function runComponent(
  pillar: Pillar,
  name: string,
  bundle: AccountBundle,
  model: ModelConfig = DEFAULT_MODEL,
): ComponentResult {
  const fn = COMPONENTS[pillar][name];
  if (!fn) throw new Error(`Unknown component ${pillar}.${name}`);
  const result = fn(bundle, {
    curve: model.componentConfig[pillar]?.[name]?.curve,
    params: model.params,
  });
  if (
    result.score !== null &&
    (result.score < 0 || result.score > 100 || Number.isNaN(result.score))
  )
    throw new Error(`${pillar}.${name} produced an out-of-range score ${result.score}`);
  return result;
}
