import type { Extraction, ExtractionKind, ExtractionSourceType } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";

/**
 * Extractions as the product reads them (M9): for each source, only the rows written by the
 * newest prompt version that has read it. An older version's rows stay as history; once a newer
 * run has read the source — even one that found nothing — they no longer count. Every consumer of
 * Extraction (promises, goals, signals, themes, sentiment views) goes through here, so a prompt
 * bump can never double-count a source.
 */
const semver = (v: string) => v.split(".").map(Number) as [number, number, number];

export function compareVersions(a: string, b: string): number {
  const x = semver(a);
  const y = semver(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const TRIGGER_PREFIX: Record<string, string> = {
  MESSAGE: "MESSAGE",
  NOTE: "NOTE",
  CALL_TRANSCRIPT: "CALL_TRANSCRIPT",
  TICKET: "TICKET",
  SURVEY_RESPONSE: "SURVEY_RESPONSE",
  FILE: "FILE",
};

/** The source a Watcher trigger id names: `MESSAGE:id@v`, `CALL_TRANSCRIPT:id#chunk@v`. */
function sourceOfTrigger(triggerId: string): { key: string; version: string } | null {
  const at = triggerId.lastIndexOf("@");
  if (at < 0) return null;
  const head = triggerId.slice(0, at);
  const colon = head.indexOf(":");
  if (colon < 0) return null;
  const type = head.slice(0, colon);
  if (!TRIGGER_PREFIX[type]) return null;
  return { key: head, version: triggerId.slice(at + 1) };
}

export async function currentExtractions(
  db: ScopedDb,
  where: {
    kinds?: ExtractionKind[];
    accountIds?: string[];
    sourceType?: ExtractionSourceType;
    since?: Date;
  } = {},
): Promise<Extraction[]> {
  const rows = await db.extraction.findMany({
    where: {
      ...(where.kinds ? { kind: { in: where.kinds } } : {}),
      ...(where.accountIds ? { accountId: { in: where.accountIds } } : {}),
      ...(where.sourceType ? { sourceType: where.sourceType } : {}),
      ...(where.since ? { createdAt: { gte: where.since } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) return [];
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  // The newest version that has read each source (chunk-aware), from the runs, so a newer read
  // that found nothing still hides the older rows.
  const runs = await db.agentRun.findMany({
    where: {
      agentKey: "watcher",
      triggerType: "extraction",
      status: "SUCCEEDED",
      OR: sourceIds.map((id) => ({ triggerId: { contains: `:${id}` } })),
    },
    select: { triggerId: true },
  });
  const latest = new Map<string, string>();
  for (const r of runs) {
    const s = sourceOfTrigger(r.triggerId);
    if (!s) continue;
    const base = s.key; // includes the chunk for calls
    const cur = latest.get(base);
    if (!cur || compareVersions(s.version, cur) > 0) latest.set(base, s.version);
  }
  const keyOf = (r: Extraction) =>
    r.sourceType === "CALL_TRANSCRIPT"
      ? `CALL_TRANSCRIPT:${r.sourceId}#${r.chunkIndex}`
      : `${r.sourceType}:${r.sourceId}`;
  return rows.filter((r) => {
    const v = latest.get(keyOf(r));
    return v === undefined || r.promptVersion === v;
  });
}
