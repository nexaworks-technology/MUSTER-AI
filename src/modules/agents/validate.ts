import type { Citation, ContextBundle, ContextRecord } from "./schemas";

/**
 * The checks that stand between model output and anything a user sees (ARCHITECTURE §1.3 step
 * 6, Rules 1 and 4). Pure: the executor and the golden replay tests run the same code.
 */

export const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

const keyOf = (sourceType: string, sourceId: string) => `${sourceType}|${sourceId}`;

/** Everything a record says, as one searchable string. */
export function recordText(r: ContextRecord): string {
  return normalizeWhitespace(
    Object.values(r.fields)
      .filter((v) => v !== null)
      .map(String)
      .join("\n"),
  );
}

/** Problems with the citations; empty means every id was given and every quote is verbatim. */
export function checkCitations(citations: Citation[], bundle: ContextBundle): string[] {
  const byKey = new Map(bundle.map((r) => [keyOf(r.sourceType, r.sourceId), r]));
  const problems: string[] = [];
  for (const c of citations) {
    const record = byKey.get(keyOf(c.sourceType, c.sourceId));
    if (!record) {
      problems.push(`cites ${c.sourceType} ${c.sourceId}, which the run was not given`);
      continue;
    }
    if (c.quote !== undefined && !recordText(record).includes(normalizeWhitespace(c.quote)))
      problems.push(`quote "${c.quote}" is not in ${c.sourceType} ${c.sourceId}`);
  }
  return problems;
}

/** Ids cited by id only (e.g. citesReasonIds); each must be a record of the given type in the bundle. */
export function checkCitedIds(
  ids: Array<{ sourceType: string; sourceId: string }>,
  bundle: ContextBundle,
): string[] {
  return checkCitations(ids, bundle);
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** "1,650" → 1650, "20.40" → 20.4; a number is compared by value, whatever its formatting. */
function numbersIn(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.match(NUMBER) ?? []) {
    // A comma followed by exactly three digits is a thousands separator; otherwise a decimal.
    const cleaned = /,\d{3}(?!\d)/.test(raw) ? raw.replaceAll(",", "") : raw.replace(",", ".");
    const value = Number(cleaned);
    if (Number.isFinite(value) && !out.has(value)) out.set(value, raw);
  }
  return out;
}

/**
 * Every number in the narrative (counts, money, dates, percentages) must appear in a record the
 * narrative cites (founder point 6). No LLM originates a number (D-75).
 */
export function checkNumbers(texts: string[], cited: ContextBundle): string[] {
  const known = new Set<number>();
  for (const r of cited) for (const v of numbersIn(recordText(r)).keys()) known.add(v);
  const problems: string[] = [];
  for (const t of texts)
    for (const [value, raw] of numbersIn(t))
      if (!known.has(value)) problems.push(`the number "${raw}" is not in any record it cites`);
  return [...new Set(problems)];
}

/** The bundle records a set of citations points at (for the number check). */
export function citedRecords(
  ids: Array<{ sourceType: string; sourceId: string }>,
  bundle: ContextBundle,
): ContextBundle {
  const wanted = new Set(ids.map((c) => keyOf(c.sourceType, c.sourceId)));
  return bundle.filter((r) => wanted.has(keyOf(r.sourceType, r.sourceId)));
}

/**
 * Agents never originate money or scores: forbidden fields in proposed actions are replaced by the
 * deterministic value, or removed when code has none (ARCHITECTURE §1.3 6c). Never mutates input.
 */
export function applyForbiddenNumeric<T extends Record<string, unknown>>(
  actions: T[],
  forbidden: readonly string[],
  facts: Record<string, number>,
): T[] {
  return actions.map((a) => {
    const copy: Record<string, unknown> = { ...a };
    for (const f of forbidden) {
      if (f in facts) copy[f] = facts[f];
      else delete copy[f];
    }
    return copy as T;
  });
}
