import type { ContextBundle } from "./schemas";

/**
 * Short cite handles for the records a run was given (FIX-2026-11-11-ASK2, item 2). A model asked
 * to cite a record "by its id exactly as given" copies a 25-character random id imperfectly: in
 * the evidence run it kept the first 17 characters and invented the tail, so a record it HAD been
 * given was refused as "not given". Each record is shown with a handle (R1, R2, …) and citations
 * may use it; code maps the handle back to the real (sourceType, sourceId) BEFORE the citation
 * checker runs. This never widens what can be cited:
 *   - a handle that names no record in this run stays as written and is refused by the checker;
 *   - an id that is not a handle is left exactly as written (the checker still requires it to be a
 *     record in this run), so a mangled id is still refused;
 *   - the handle is not part of the record's fields, so it cannot make a number "appear" in a record.
 */
const HANDLE = /^R(\d+)$/;

export const handleOf = (index: number) => `R${index + 1}`;

/** The records as the model sees them: the handle first, then the record exactly as it is. */
export const withHandles = (bundle: ContextBundle) =>
  bundle.map((r, i) => ({ cite: handleOf(i), ...r }));

const CITATION_LISTS = ["citations", "figures"] as const;

/** Replaces handle citations (in `citations` and `figures`) with the record each one names. */
export function resolveHandles(output: unknown, bundle: ContextBundle): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const out: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  for (const key of CITATION_LISTS) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((item: unknown) => {
      if (item === null || typeof item !== "object") return item;
      const c = item as { sourceId?: unknown };
      const m = typeof c.sourceId === "string" ? HANDLE.exec(c.sourceId) : null;
      const rec = m ? bundle[Number(m[1]) - 1] : undefined;
      return rec ? { ...item, sourceType: rec.sourceType, sourceId: rec.sourceId } : item;
    });
  }
  return out;
}
