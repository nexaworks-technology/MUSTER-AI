import type { Metric, MetricSet } from "./service";
import { formatMoney } from "@/lib/money";

/**
 * The Renewal Brief's locked metrics (M7 B3, spec §6H2): health by part, the renewal's confidence,
 * open risks, goals, promise status and expansion chance. Pure: it takes facts the caller read from
 * records and returns the metric set, so the same records always give the same brief. Every
 * metric carries the records behind it. Nothing here is written by a model.
 */
export const RENEWAL_BRIEF_KEYS = [
  "renewal.date",
  "renewal.daysTo",
  "renewal.noticeDeadline",
  "renewal.confidence",
  "renewal.confidenceBand",
  "renewal.arr",
  "health.band",
  "health.overall",
  "health.adoption",
  "health.engagement",
  "health.support",
  "health.relationship",
  "health.commercial",
  "health.sentiment",
  "risks.count",
  "risks.top",
  "goals.status",
  "promises.status",
  "expansion.chance",
  "expansion.estimate",
  "plan.nextStepDate",
] as const;
export type BriefKey = (typeof RENEWAL_BRIEF_KEYS)[number];

/** The only keys that may appear in text that goes to the customer: nothing internal, no money. */
export const CUSTOMER_SAFE_KEYS: readonly BriefKey[] = ["renewal.date"];

type Src = { sourceType: string; sourceId?: string };
export interface BriefFacts {
  renewal: {
    id: string;
    contractId: string;
    dateText: string;
    daysTo: number;
    noticeDeadlineText: string | null;
    confidence: number;
    band: "HIGH" | "MEDIUM" | "LOW";
    arrMinor: bigint | null;
    currency: string | null;
  };
  health: {
    snapshotId: string;
    band: "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";
    overall: number | null;
    parts: Record<
      "adoption" | "engagement" | "support" | "relationship" | "commercial" | "sentiment",
      number | null
    >;
  } | null;
  /** Open WARN/CRITICAL risk signals, most severe first. */
  risks: Array<{ id: string; title: string; severity: "WARN" | "CRITICAL" }>;
  goals: Array<{ id: string; status: "OPEN" | "ACHIEVED" | "MISSED" | "DROPPED" }>;
  expansion: {
    id: string;
    titles: string[];
    estimateMinor: bigint | null;
    currency: string | null;
  } | null;
  /** The next step's date, computed by code from the business date and the notice deadline. */
  nextStep?: { dateText: string } | null;
}

const BAND_WORDS = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" } as const;
const HEALTH_WORDS = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At risk",
  INSUFFICIENT_DATA: "Not enough data",
} as const;
const num = (n: number) => (Math.round(n * 10) / 10).toString();

function m(
  key: BriefKey,
  label: string,
  kind: Metric["kind"],
  value: Metric["value"],
  text: string,
  sources: Src[],
  money = false,
): [BriefKey, Metric] {
  return [key, { key, label, kind, value, text, money, sources }];
}

export function briefMetrics(f: BriefFacts): MetricSet {
  const r = f.renewal;
  const h = f.health;
  const hs: Src[] = h ? [{ sourceType: "HealthScoreSnapshot", sourceId: h.snapshotId }] : [];
  const part = (k: keyof NonNullable<BriefFacts["health"]>["parts"], label: string) =>
    m(
      `health.${k}`,
      `Health: ${label}`,
      "number",
      h?.parts[k] ?? null,
      h && h.parts[k] !== null ? num(h.parts[k]!) : "No data",
      hs,
    );
  const sev = f.risks[0];
  const achieved = f.goals.filter((g) => g.status === "ACHIEVED").length;
  const counted = f.goals.filter((g) => g.status !== "DROPPED");
  const rs: Src = { sourceType: "Renewal", sourceId: r.id };
  const entries: Array<[BriefKey, Metric]> = [
    m("renewal.date", "Renewal date", "date", r.dateText, r.dateText, [
      rs,
      { sourceType: "Contract", sourceId: r.contractId },
    ]),
    m("renewal.daysTo", "Days to renewal", "number", r.daysTo, `${r.daysTo} days`, [rs]),
    m(
      "renewal.noticeDeadline",
      "Notice deadline",
      "date",
      r.noticeDeadlineText,
      r.noticeDeadlineText ?? "No notice period on file",
      [rs, { sourceType: "Contract", sourceId: r.contractId }],
    ),
    m("renewal.confidence", "Renewal confidence", "percent", r.confidence, `${r.confidence}%`, [
      rs,
    ]),
    m("renewal.confidenceBand", "Confidence band", "text", r.band, BAND_WORDS[r.band], [rs]),
    m(
      "renewal.arr",
      "Contract value (ARR)",
      "money",
      r.arrMinor === null ? null : r.arrMinor.toString(),
      r.arrMinor !== null && r.currency
        ? formatMoney({ minor: r.arrMinor, currency: r.currency })
        : "No contract value on file",
      [{ sourceType: "Contract", sourceId: r.contractId }],
      true,
    ),
    m(
      "health.band",
      "Health",
      "text",
      h?.band ?? null,
      h ? HEALTH_WORDS[h.band] : "No health score on file",
      hs,
    ),
    m(
      "health.overall",
      "Health: overall",
      "number",
      h?.overall ?? null,
      h && h.overall !== null ? num(h.overall) : "No data",
      hs,
    ),
    part("adoption", "adoption"),
    part("engagement", "engagement"),
    part("support", "support"),
    part("relationship", "relationship"),
    part("commercial", "commercial"),
    part("sentiment", "sentiment"),
    m(
      "risks.count",
      "Open risks",
      "number",
      f.risks.length,
      f.risks.length === 0
        ? "No open risk signals"
        : `${f.risks.length} open risk signal${f.risks.length === 1 ? "" : "s"}`,
      f.risks.map((x) => ({ sourceType: "Signal", sourceId: x.id })),
    ),
    m(
      "risks.top",
      "Most serious open risk",
      "text",
      sev?.title ?? null,
      sev?.title ?? "None open",
      sev ? [{ sourceType: "Signal", sourceId: sev.id }] : [],
    ),
    m(
      "goals.status",
      "Goals",
      "text",
      counted.length ? `${achieved}/${counted.length}` : null,
      counted.length === 0
        ? "No goals on file"
        : `${achieved} of ${counted.length} goal${counted.length === 1 ? "" : "s"} achieved`,
      f.goals.map((g) => ({ sourceType: "Goal", sourceId: g.id })),
    ),
    m(
      "promises.status",
      "Promises",
      "text",
      null,
      "Promise tracking is not connected yet, so no promise status is shown",
      [],
    ),
    m(
      "expansion.chance",
      "Expansion chance",
      "text",
      f.expansion ? "OPEN" : null,
      f.expansion
        ? `An open expansion opportunity: ${f.expansion.titles.join("; ") || "raised by usage signals"}`
        : "No open expansion opportunity",
      f.expansion ? [{ sourceType: "ExpansionOpportunity", sourceId: f.expansion.id }] : [],
    ),
    m(
      "expansion.estimate",
      "Expansion estimate",
      "money",
      f.expansion?.estimateMinor?.toString() ?? null,
      f.expansion?.estimateMinor != null && f.expansion.currency
        ? `Estimate: ${formatMoney({ minor: f.expansion.estimateMinor, currency: f.expansion.currency })} ARR`
        : "No estimate on file",
      f.expansion ? [{ sourceType: "ExpansionOpportunity", sourceId: f.expansion.id }] : [],
      true,
    ),
    m(
      "plan.nextStepDate",
      "Next step date",
      "date",
      f.nextStep?.dateText ?? null,
      f.nextStep?.dateText ?? "No next step set",
      [rs],
    ),
  ];
  return Object.fromEntries(entries);
}
