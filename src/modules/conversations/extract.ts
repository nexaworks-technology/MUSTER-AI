import { z } from "zod";

/**
 * Planning for the Watcher (M9): which sources still need reading at the current prompt version,
 * and which a prompt-version bump should read again. Pure over ids, so the planner never holds
 * customer text and the `conversations.reextract` job payload can carry ids only (Rule 7).
 */
export type WatchedSourceType = "MESSAGE" | "NOTE" | "CALL_TRANSCRIPT";

export interface WatchedSource {
  sourceType: WatchedSourceType;
  sourceId: string;
  chunkIndex: number;
}

export interface PlannedSource extends WatchedSource {
  triggerId: string;
}

/** `MESSAGE:<id>@<version>`, `NOTE:<id>@…`, `CALL_TRANSCRIPT:<id>#<chunk>@…` (M4 shape kept). */
export function triggerIdFor(s: WatchedSource, version: string): string {
  const where = s.sourceType === "CALL_TRANSCRIPT" ? `${s.sourceId}#${s.chunkIndex}` : s.sourceId;
  return `${s.sourceType}:${where}@${version}`;
}

export interface PlanInput {
  messages: ReadonlyArray<{ id: string; direction: "INBOUND" | "OUTBOUND" }>;
  notes: ReadonlyArray<{ id: string }>;
  transcripts: ReadonlyArray<{ id: string; chunks: number }>;
  /** Trigger ids of every Watcher run that already happened (any version). */
  done: ReadonlySet<string>;
  version: string;
  limit?: number;
}

function allSources(i: Pick<PlanInput, "messages" | "notes" | "transcripts">): WatchedSource[] {
  return [
    ...i.messages.map((m) => ({ sourceType: "MESSAGE" as const, sourceId: m.id, chunkIndex: 0 })),
    ...i.notes.map((n) => ({ sourceType: "NOTE" as const, sourceId: n.id, chunkIndex: 0 })),
    ...i.transcripts.flatMap((t) =>
      Array.from({ length: t.chunks }, (_, chunkIndex) => ({
        sourceType: "CALL_TRANSCRIPT" as const,
        sourceId: t.id,
        chunkIndex,
      })),
    ),
  ];
}

const plan = (s: WatchedSource, version: string): PlannedSource => ({
  ...s,
  triggerId: triggerIdFor(s, version),
});

export function planSources(i: PlanInput): PlannedSource[] {
  return allSources(i)
    .map((s) => plan(s, i.version))
    .filter((s) => !i.done.has(s.triggerId))
    .slice(0, i.limit ?? Number.POSITIVE_INFINITY);
}

export class StaleReextractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleReextractError";
  }
}

const versionOf = (triggerId: string) => triggerId.slice(triggerId.lastIndexOf("@") + 1);

/**
 * Sources an earlier prompt version already read and the current one has not. Refuses when no
 * earlier version ever ran: that is a first read (a backfill), not a re-extraction.
 */
export function planReextract(i: PlanInput): PlannedSource[] {
  const earlier = new Set<string>();
  for (const id of i.done)
    if (versionOf(id) !== i.version) earlier.add(id.slice(0, id.lastIndexOf("@")));
  if (earlier.size === 0)
    throw new StaleReextractError(
      "No earlier prompt version has read anything here, so there is nothing to re-extract.",
    );
  return planSources({ ...i, limit: undefined })
    .filter((s) => earlier.has(s.triggerId.slice(0, s.triggerId.lastIndexOf("@"))))
    .slice(0, i.limit ?? Number.POSITIVE_INFINITY);
}

/** The `conversations.reextract` job: the workspace and the prompt version, nothing else. */
export const reextractPayload = z
  .object({ workspaceId: z.string().min(1), promptVersion: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .strict();
export type ReextractPayload = z.infer<typeof reextractPayload>;
