import type { ExtractionKind, SentimentLabel } from "@prisma/client";
import { z } from "zod";

/**
 * The extraction contract (ARCHITECTURE §5.3, D-75). The Watcher's model output is untrusted
 * until each item passes here: its quote must be a verbatim substring of the source text (after
 * whitespace normalisation) and its payload must match its kind's schema. Anything else is
 * dropped and counted, never repaired. Pure; the Watcher and the golden replay share it.
 */
export const ITEM_KINDS = [
  "COMPETITOR",
  "BUDGET_CONCERN",
  "PROMISE",
  "GOAL",
  "CANCEL_LANGUAGE",
  "EXPORT_LANGUAGE",
  "COMPLAINT",
  "RENEWAL_CONCERN",
  "ACTION_ITEM",
  "DECISION",
  "THEME",
  "INTENT",
] as const satisfies readonly ExtractionKind[];

export const INTENTS = [
  "question",
  "request",
  "complaint",
  "cancellation",
  "pricing",
  "legal",
  "security",
  "escalation",
  "praise",
  "other",
] as const;

/** What the model returns (one call per source record). Payload fields are flat and optional. */
export const extractionModelOutput = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      quote: z.string(),
      confidence: z.number().min(0).max(1),
      payload: z.object({
        competitorName: z.string().optional(),
        summary: z.string().optional(),
        what: z.string().optional(),
        dueDate: z.string().nullable().optional(),
        owner: z.string().nullable().optional(),
        /** The model's guess at who promised (M9 D11): only ever a flagged suggestion. */
        party: z.enum(["us", "customer"]).nullable().optional(),
        goal: z.string().optional(),
        theme: z.string().optional(),
        intent: z.string().optional(),
        decision: z.string().optional(),
      }),
    }),
  ),
  sentiment: z
    .object({ label: z.enum(["NEGATIVE", "NEUTRAL", "POSITIVE", "MIXED"]), quote: z.string() })
    .nullable()
    .optional(),
});
export type ExtractionModelOutput = z.infer<typeof extractionModelOutput>;

const text = z.string().trim().min(1);
export const PAYLOAD: Record<(typeof ITEM_KINDS)[number], z.ZodType> = {
  COMPETITOR: z.object({ competitorName: text }),
  BUDGET_CONCERN: z.object({ summary: text }),
  PROMISE: z.object({
    what: text,
    dueDate: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    party: z.enum(["us", "customer"]).nullable().optional(),
  }),
  GOAL: z.object({ goal: text }),
  CANCEL_LANGUAGE: z.object({ summary: z.string().optional() }),
  EXPORT_LANGUAGE: z.object({ summary: z.string().optional() }),
  COMPLAINT: z.object({ theme: text }),
  RENEWAL_CONCERN: z.object({ summary: text }),
  ACTION_ITEM: z.object({ what: text, owner: z.string().nullable().optional() }),
  DECISION: z.object({ decision: text }),
  THEME: z.object({ theme: text }),
  INTENT: z.object({ intent: z.enum(INTENTS) }),
};

export interface KeptItem {
  itemIndex: number;
  kind: (typeof ITEM_KINDS)[number];
  quote: string;
  payload: Record<string, unknown>;
  confidence: number;
  flags: string[];
}

export interface Dropped {
  index: number;
  kind: string;
  reason: string;
}

export interface ValidatedExtraction {
  kept: KeptItem[];
  sentiment: { label: SentimentLabel; quote: string } | null;
  dropped: Dropped[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MENTIONS_DATE =
  /\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(today|tomorrow|tonight)\b/i;

/** A due date is kept only when it is a real calendar day and the quote itself names a date. */
function promiseDate(raw: unknown, quote: string): string | null {
  if (typeof raw !== "string" || !ISO_DAY.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(+d) || d.toISOString().slice(0, 10) !== raw) return null;
  if (!MENTIONS_DATE.test(quote)) return null;
  // The quote must name this date: its ISO form, or its day number.
  const day = String(Number(raw.slice(8, 10)));
  return quote.includes(raw) || new RegExp(`\\b${day}\\b`).test(quote) ? raw : null;
}

export function validateExtraction(source: string, raw: unknown): ValidatedExtraction {
  const out = extractionModelOutput.parse(raw);
  const haystack = norm(source);
  const inSource = (q: string) => norm(q).length > 0 && haystack.includes(norm(q));
  const kept: KeptItem[] = [];
  const dropped: Dropped[] = [];

  out.items.forEach((item, index) => {
    const drop = (reason: string) => dropped.push({ index, kind: item.kind, reason });
    if (!(ITEM_KINDS as readonly string[]).includes(item.kind))
      return drop(`unknown kind "${item.kind}"`);
    const kind = item.kind as (typeof ITEM_KINDS)[number];
    if (!inSource(item.quote)) return drop("quote not found in the source text");
    if (kind === "PROMISE" && norm(item.quote).endsWith("?"))
      return drop("a question is not a promise");
    const parsed = PAYLOAD[kind].safeParse(item.payload);
    if (!parsed.success)
      return drop(
        `payload: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    const payload = { ...(parsed.data as Record<string, unknown>) };
    const flags: string[] = [];
    if (kind === "PROMISE") {
      payload.dueDate = promiseDate(payload.dueDate, item.quote);
      if (payload.dueDate === null) flags.push("no_date");
    }
    kept.push({
      itemIndex: index,
      kind,
      quote: norm(item.quote),
      payload,
      confidence: item.confidence,
      flags,
    });
  });

  let sentiment: ValidatedExtraction["sentiment"] = null;
  if (out.sentiment) {
    if (inSource(out.sentiment.quote))
      sentiment = { label: out.sentiment.label, quote: norm(out.sentiment.quote) };
    else
      dropped.push({ index: -1, kind: "SENTIMENT", reason: "quote not found in the source text" });
  }
  return { kept, sentiment, dropped };
}
