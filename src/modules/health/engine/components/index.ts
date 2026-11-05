import { addDays } from "@/lib/dates";
import { round4 } from "../format";
import { DEFAULT_MODEL, type ModelConfig, type Pillar } from "../model";
import type { AccountBundle, ComponentResult, PillarComponents } from "../types";
import { ADOPTION } from "./adoption";
import { COMMERCIAL } from "./commercial";
import { ENGAGEMENT } from "./engagement";
import { RELATIONSHIP } from "./relationship";
import { SUPPORT } from "./support";

/**
 * Sentiment (M4): the share of negative customer ticket messages in the last 90 days, from AI
 * labels that were written only after their quote was verified (D-75, D-77). The labels are data;
 * the score is this formula. Fewer than 2 labelled messages = not enough data (never lowers the
 * score). Surveys arrive in M10.
 */
const SENTIMENT_MIN_LABELLED = 2;

function sentimentShare(b: AccountBundle): ComponentResult {
  const C = "sentiment_share";
  const I = "negative_sentiment_share_90d";
  const from = addDays(b.asOf, -89);
  const labelled = (b.messages ?? []).filter(
    (m) =>
      m.channel === "TICKET" &&
      m.direction === "INBOUND" &&
      m.sentimentLabel !== undefined &&
      m.date >= from &&
      m.date <= b.asOf,
  );
  if (labelled.length < SENTIMENT_MIN_LABELLED)
    return {
      score: null,
      reason: {
        component: C,
        kind: "MISSING_DATA",
        input: I,
        message:
          labelled.length === 0
            ? "No customer ticket messages in the last 90 days have a sentiment label yet."
            : "Only 1 customer ticket message in the last 90 days has a sentiment label; 2 are needed.",
        sources: [],
      },
    };
  const negative = labelled.filter((m) => m.sentimentLabel === "NEGATIVE").length;
  const mixed = labelled.filter((m) => m.sentimentLabel === "MIXED").length;
  const share = (negative + 0.5 * mixed) / labelled.length;
  return {
    score: round4((1 - share) * 100),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${negative} of ${labelled.length} customer ticket messages in the last 90 days read as negative${
        mixed ? ` and ${mixed} as mixed` : ""
      } (AI labels, each checked against a quote from the message).`,
      value: round4(share),
      periodStart: from,
      periodEnd: b.asOf,
      sources: labelled.map((m) => ({ sourceType: "Message", sourceId: m.id })),
    },
  };
}

function normalizeSurveyScore(type: "NPS" | "CSAT" | "CES", score: number): number {
  if (type === "NPS") return Math.max(0, Math.min(100, Math.round((score / 10) * 100)));
  if (type === "CSAT") return Math.max(0, Math.min(100, Math.round((score / 5) * 100)));
  if (type === "CES") return Math.max(0, Math.min(100, Math.round((score / 7) * 100)));
  return Math.max(0, Math.min(100, score));
}

function surveyAverage(b: AccountBundle): ComponentResult {
  const from = addDays(b.asOf, -90);
  const inWindow = (b.surveys ?? []).filter((s) => s.date >= from && s.date <= b.asOf);
  if (inWindow.length === 0) {
    return {
      score: null,
      reason: {
        component: "survey_average",
        kind: "MISSING_DATA",
        input: "survey_average",
        message: "No survey responses yet.",
        sources: [],
      },
    };
  }
  const sum = inWindow.reduce((acc, s) => acc + normalizeSurveyScore(s.type, s.score), 0);
  const mean = Math.round(sum / inWindow.length);
  return {
    score: mean,
    reason: {
      component: "survey_average",
      kind: "EVIDENCE",
      input: "survey_average",
      message: `${inWindow.length} survey response(s) in the last 90 days, averaging ${mean}/100.`,
      value: mean,
      periodStart: from,
      periodEnd: b.asOf,
      sources: inWindow.map((s) => ({ sourceType: "SurveyResponse", sourceId: s.id })),
    },
  };
}

const SENTIMENT: PillarComponents = {
  sentiment_share: (b) => sentimentShare(b),
  survey_average: (b) => surveyAverage(b),
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
