import { z } from "zod";
import { localDate, realClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { loadContext } from "@/modules/health/service";
import { ingestBatch } from "../ingest.service";
import type { NormalizedUsageDay } from "../normalized";

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

const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const SESSION_EVENTS = new Set(["session_started", "session_start"]);

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

  type Day = NormalizedUsageDay & {
    userMap: Map<string, { events: number; sessions: number }>;
    featureMap: Map<string, { people: Set<string>; events: number }>;
  };
  const days = new Map<string, Day>();
  for (const e of p.events) {
    if (e.kind !== "track") continue;
    const date = localDate(new Date(e.at), timeZone);
    const key = `${e.groupRef}|${date}`;
    const day =
      days.get(key) ??
      days
        .set(key, {
          accountExternalId: e.groupRef,
          date,
          mode: "ADD",
          events: 0,
          sessions: 0,
          users: [],
          features: [],
          userMap: new Map(),
          featureMap: new Map(),
        })
        .get(key)!;
    const name = normalizeName(e.event ?? "");
    const session = SESSION_EVENTS.has(name);
    day.events += 1;
    if (session) day.sessions += 1;
    const user = day.userMap.get(e.userId) ?? { events: 0, sessions: 0 };
    user.events += 1;
    if (session) user.sessions += 1;
    day.userMap.set(e.userId, user);
    const feature = e.feature ?? (known.has(name) ? name : undefined);
    if (feature) {
      const f = day.featureMap.get(feature) ?? { people: new Set<string>(), events: 0 };
      f.people.add(e.userId);
      f.events += 1;
      day.featureMap.set(feature, f);
    }
  }
  const records: NormalizedUsageDay[] = [...days.values()].map((d) => ({
    accountExternalId: d.accountExternalId,
    date: d.date,
    mode: "ADD",
    events: d.events,
    sessions: d.sessions,
    users: [...d.userMap].map(([externalUserId, u]) => ({
      externalUserId,
      email: emails.get(externalUserId),
      ...u,
    })),
    features: [...d.featureMap].map(([featureKey, f]) => ({
      featureKey,
      users: f.people.size,
      events: f.events,
    })),
  }));

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
