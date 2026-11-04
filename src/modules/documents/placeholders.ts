/**
 * The narrative placeholder rule (M7 B3, ARCHITECTURE §3.2 Document): a document's numbers are
 * locked metrics computed by code; its narrative is text in which a number appears only as
 * `{{metric.key}}`. A free-text number (matching a metric or not), an unknown key and a malformed
 * brace expression are refused, never repaired. The same validator guards the Renewal Manager's
 * output and a person's edit, and is reused by QBR documents (M10). Pure.
 *
 * Limit, stated plainly: a number spelled out in words ("forty-one") is not a digit and is not
 * caught here.
 */
export interface NarrativeBlock {
  id: string;
  type: "heading" | "paragraph" | "bullet";
  text: string;
}

export interface NarrativeProblem {
  blockId: string;
  kind: "NUMBER_IN_TEXT" | "UNKNOWN_METRIC" | "MALFORMED";
  message: string;
}

const KEY = "[a-z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)*";
const PLACEHOLDER = new RegExp(`\\{\\{metric\\.(${KEY})\\}\\}`, "g");
/** An ISO date counts as one number, so "2026-11-09" is one problem, not three. */
const NUMBER = /\d{4}-\d{2}-\d{2}|\d+(?:,\d{3})*(?:\.\d+)?/g;

/** Metric key written in a placeholder → the text to compare a typed number against. */
export type MetricTexts = Record<string, string>;

const digitsOnly = (s: string) => s.replace(/[^\d]/g, "");

export interface ValidateOptions {
  /**
   * "forbid" (default): any digit outside a placeholder is refused. "allow": digits are left to the
   * agent number check (each must appear in a record the text cites); only the placeholder syntax
   * and keys are checked here. Used where a narrative may repeat a usage count from its records
   * but must never carry a money figure (that is a placeholder only).
   */
  numbers?: "forbid" | "allow";
}

export function validateNarrative(
  blocks: readonly NarrativeBlock[],
  allowedKeys: readonly string[],
  metricTexts: MetricTexts = {},
  opts: ValidateOptions = {},
): NarrativeProblem[] {
  const allowed = new Set(allowedKeys);
  const problems: NarrativeProblem[] = [];
  for (const b of blocks) {
    const keys = [...b.text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    for (const k of keys)
      if (!allowed.has(k))
        problems.push({
          blockId: b.id,
          kind: "UNKNOWN_METRIC",
          message: `{{metric.${k}}} is not a metric the system computes for this document`,
        });
    const rest = b.text.replace(PLACEHOLDER, " ");
    if (/\{\{|\}\}/.test(rest))
      problems.push({
        blockId: b.id,
        kind: "MALFORMED",
        message: "a brace expression that is not a {{metric.key}} placeholder",
      });
    for (const raw of opts.numbers === "allow" ? [] : new Set(rest.match(NUMBER) ?? [])) {
      const match = Object.entries(metricTexts).find(
        ([, text]) => digitsOnly(text).includes(digitsOnly(raw)) && digitsOnly(raw).length > 0,
      );
      problems.push({
        blockId: b.id,
        kind: "NUMBER_IN_TEXT",
        message: match
          ? `the number "${raw}" is written in the text; use {{metric.${match[0]}}}`
          : `the number "${raw}" is written in the text; numbers may appear only as {{metric.key}} placeholders`,
      });
    }
  }
  return problems;
}

/** Substitutes each placeholder with its locked metric's text. Throws on a key with no metric. */
export function renderNarrative(
  blocks: readonly NarrativeBlock[],
  metrics: Record<string, { text: string }>,
): NarrativeBlock[] {
  return blocks.map((b) => ({
    ...b,
    text: b.text.replace(PLACEHOLDER, (_all, key: string) => {
      const m = metrics[key];
      if (!m) throw new Error(`No metric "${key}" to render`);
      return m.text;
    }),
  }));
}
