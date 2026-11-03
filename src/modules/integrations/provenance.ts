/**
 * Field provenance and the Q-32 conflict rule (founder decision D1, recorded as D-83).
 *
 * For each field a connector sends:
 *  - no value from the provider → no opinion, nothing changes (missing data never erases data);
 *  - the field is empty here → the provider fills it and becomes its source;
 *  - same value → nothing changes;
 *  - different value, and the field's current source IS this provider → the provider's own value
 *    changed at the provider, so it updates in place;
 *  - different value from any other source (the other CRM, CSV, manual entry, seed) → a CONFLICT
 *    for a person to resolve. Nothing is overwritten. Between two CRMs the earlier-connected one
 *    is primary, which the conflict names so the person knows which value the rule prefers.
 */
export type FieldValue = string | null | undefined;

export interface FieldConflict {
  field: string;
  current: string;
  incoming: string;
  /** Who set the current value (a RecordSource). */
  currentSource: string;
}

export interface MergeResult {
  /** Fields to write. Empty = unchanged. */
  data: Record<string, string>;
  /** The full provenance map after the merge. */
  fieldSources: Record<string, string>;
  conflicts: FieldConflict[];
}

const empty = (v: FieldValue): v is null | undefined | "" =>
  v === null || v === undefined || v === "";

export function mergeFields(input: {
  current: Record<string, FieldValue>;
  /** The record's provenance map (missing field = `recordSource`). */
  fieldSources: Record<string, string>;
  recordSource: string;
  incoming: Record<string, FieldValue>;
  /** The provider doing this sync (a RecordSource). */
  source: string;
}): MergeResult {
  const data: Record<string, string> = {};
  const fieldSources = { ...input.fieldSources };
  const conflicts: FieldConflict[] = [];
  for (const [field, value] of Object.entries(input.incoming)) {
    if (empty(value)) continue;
    const current = input.current[field];
    if (empty(current)) {
      data[field] = value;
      fieldSources[field] = input.source;
      continue;
    }
    if (current === value) continue;
    const owner = input.fieldSources[field] ?? input.recordSource;
    if (owner === input.source) {
      data[field] = value;
      continue;
    }
    conflicts.push({ field, current, incoming: value, currentSource: owner });
  }
  return { data, fieldSources, conflicts };
}

/** Reads a Json provenance column defensively (it is our own data, but Json is untyped). */
export function readFieldSources(json: unknown): Record<string, string> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return Object.fromEntries(
    Object.entries(json as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
}
