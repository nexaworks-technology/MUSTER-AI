/**
 * Full account timeline (spec §6A4): items from every source, in time order (newest first).
 * Sources are a registry so later milestones add theirs (signals and health in M3, agent
 * actions in M4, meetings in M10). Paging is keyset on (at desc, key asc) — stable even when
 * new items arrive (DECISIONS D-44).
 */
import type { TimelineItem } from "./schemas";

export type { TimelineItem, TimelineKind } from "./schemas";

export interface TimelineCursor {
  at: Date;
  key: string;
}

/** Strict ordering: newer first; on equal time, smaller key first. */
export function before(
  x: Pick<TimelineItem, "at" | "key">,
  y: Pick<TimelineItem, "at" | "key">,
): number {
  const dt = y.at.getTime() - x.at.getTime();
  return dt !== 0 ? dt : x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
}

export function encodeCursor(c: TimelineCursor): string {
  return Buffer.from(`${c.at.toISOString()}|${c.key}`).toString("base64url");
}

export function decodeCursor(raw: string): TimelineCursor | null {
  try {
    const [iso, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const at = new Date(iso ?? "");
    const key = rest.join("|");
    if (Number.isNaN(at.getTime()) || !key) return null;
    return { at, key };
  } catch {
    return null;
  }
}

/** Merges per-source lists (each may be unsorted) into one page after `cursor`. */
export function mergeTimeline(
  sources: ReadonlyArray<readonly TimelineItem[]>,
  cursor: TimelineCursor | null,
  limit: number,
): { items: TimelineItem[]; nextCursor: string | null } {
  const all = sources
    .flat()
    .filter((i) => !cursor || before(cursor, i) < 0)
    .sort(before);
  const items = all.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: all.length > limit && last ? encodeCursor({ at: last.at, key: last.key }) : null,
  };
}
