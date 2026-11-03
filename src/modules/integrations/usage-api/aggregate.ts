import { z } from "zod";
import { localDate, realClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { loadContext } from "@/modules/health/service";
import { ingestBatch } from "../ingest.service";
import { foldUsage } from "./fold";

/**
 * The `usage.aggregate` worker job (M6 B1, D-23, Q-33): folds one batch of validated events into
 * daily rows through the one ingest path, then lets the events go. The events exist only in this
 * job's payload. The batch's key is written in the same transaction as the rows, so a replay (a
 * client retry, a queue retry) finds it and changes nothing.
 *
 * What counts: every `track` is an event for its person and account that day. An event named like
 * a session start (`session_started`, `Session Started`) is a session. An event belongs to a
 * feature when `properties.feature` names one, or its own name is a key in the workspace's
 * feature catalogue. "Day" is the calendar day of the event's moment in the workspace time zone.
 */
const event = z.object({
  kind: z.enum(["track", "identify"]),
  userId: z.string().min(1),
  groupRef: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
  messageId: z.string().optional(),
  event: z.string().optional(),
  feature: z.string().optional(),
  email: z.string().optional(),
});

export const aggregatePayload = z.object({
  workspaceId: z.string().min(1),
  integrationId: z.string().min(1),
  batchKey: z.string().regex(/^[a-f0-9]{64}$/),
  events: z.array(event).max(500),
});

export interface AggregateResult {
  status: "APPLIED" | "SKIPPED";
  counts?: { created: number; updated: number; unchanged: number; conflicts: number };
}

export async function aggregateUsage(raw: unknown): Promise<AggregateResult> {
  const p = aggregatePayload.parse(raw);
  const ctx = { workspaceId: p.workspaceId };
  const db = scopedDb(ctx);
  const integration = await db.integration.findUnique({
    where: { id: p.integrationId },
    select: { id: true, provider: true, status: true },
  });
  if (!integration || integration.provider !== "USAGE_API" || integration.status === "DISCONNECTED")
    return { status: "SKIPPED" };
  const [{ timeZone }, catalogue] = await Promise.all([
    loadContext(ctx),
    db.featureCatalog.findMany({ select: { featureKey: true } }),
  ]);
  const known = new Set(catalogue.map((c) => c.featureKey));

  const emails = new Map<string, string>();
  for (const e of p.events) if (e.kind === "identify" && e.email) emails.set(e.userId, e.email);

  const records = foldUsage(
    p.events
      .filter((e) => e.kind === "track")
      .map((e) => ({
        groupRef: e.groupRef,
        userId: e.userId,
        date: localDate(new Date(e.at), timeZone),
        name: e.event,
        feature: e.feature,
      })),
    { mode: "ADD", known, emails },
  );

  const result = await ingestBatch(
    { workspaceId: p.workspaceId, integrationId: p.integrationId, source: "USAGE_API" },
    { kind: "usage", records, ledgerKey: p.batchKey, ledgerEvents: p.events.length },
  );
  await db.integration.update({
    where: { id: p.integrationId },
    data: { lastSyncAt: realClock(), lastErrorPlain: null, status: "CONNECTED" },
  });
  const { created, updated, unchanged, conflicts } = result.counts;
  return {
    status: result.replayed ? "SKIPPED" : "APPLIED",
    counts: { created, updated, unchanged, conflicts },
  };
}
