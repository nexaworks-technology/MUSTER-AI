import type { Prisma } from "@prisma/client";
import { rawDb } from "@/lib/db/raw";
import { logger } from "@/lib/logger";
import { getQueue, type QueueName } from "./queues";

/**
 * Transactional outbox (DECISIONS D-22). Domain events are written in the same transaction as
 * the change that caused them; the dispatcher later moves them onto BullMQ. A crash can delay an
 * event but never lose it, and a rolled-back change never emits one.
 */
export interface OutboxEventInput {
  workspaceId: string;
  type: string;
  payload: Prisma.InputJsonObject;
  availableAt?: Date;
}

/** Write inside the caller's tenant transaction so the event commits (or not) with the change. */
export function writeOutboxEvent(tx: Prisma.TransactionClient, event: OutboxEventInput) {
  return tx.outboxEvent.create({
    data: {
      workspaceId: event.workspaceId,
      type: event.type,
      payload: event.payload,
      availableAt: event.availableAt ?? new Date(),
    },
  });
}

/** Event type → queue + job name. Each milestone registers the events it introduces. */
export type OutboxRoutes = Readonly<Record<string, { queue: QueueName; job: string }>>;

export type Enqueue = (
  queue: QueueName,
  job: string,
  data: Prisma.InputJsonObject & { workspaceId: string; outboxEventId: string },
  jobId: string,
) => Promise<unknown>;

const defaultEnqueue: Enqueue = (queue, job, data, jobId) =>
  getQueue(queue).add(job, data, { jobId });

export interface DispatchResult {
  dispatched: number;
  failed: number;
}

/**
 * Claims up to `batchSize` due events (SKIP LOCKED, so several workers can dispatch safely),
 * enqueues each with jobId = event id (BullMQ dedupes re-enqueues), then marks it processed.
 */
export async function dispatchOutbox(
  routes: OutboxRoutes,
  { enqueue = defaultEnqueue, batchSize = 100 }: { enqueue?: Enqueue; batchSize?: number } = {},
): Promise<DispatchResult> {
  return rawDb.$transaction(async (tx) => {
    const due = await tx.$queryRaw<
      Array<{ id: string; workspaceId: string; type: string; payload: Prisma.JsonObject }>
    >`
      SELECT id, "workspaceId", type, payload FROM "OutboxEvent"
      WHERE "processedAt" IS NULL AND "availableAt" <= now() AND attempts < 10
        AND NOT (type = ANY(${AWAITING_CONSUMER}))
      ORDER BY "availableAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`;
    let dispatched = 0;
    let failed = 0;
    for (const event of due) {
      const route = routes[event.type];
      try {
        if (!route) throw new Error(`No handler is registered for event type "${event.type}"`);
        await enqueue(
          route.queue,
          route.job,
          { ...event.payload, workspaceId: event.workspaceId, outboxEventId: event.id },
          `outbox-${event.id}`,
        );
        await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
        dispatched++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
        });
        logger.warn(
          { outboxEventId: event.id, type: event.type, workspaceId: event.workspaceId },
          "outbox dispatch failed",
        );
      }
    }
    return { dispatched, failed };
  });
}

/** Routes registered so far. M1 introduces no domain events; later milestones add theirs here. */
export const OUTBOX_ROUTES: OutboxRoutes = {};

/**
 * Event types written before anything consumes them (D-66): kept as records, not claimed by the
 * dispatcher (no retries, no warnings) until the milestone that consumes them registers a route
 * and removes them from this list. M3: signal.opened / signal.resolved / health.bandChanged
 * (consumed by the Health Analyst and play triggers, M4/M8).
 */
export const AWAITING_CONSUMER: string[] = [
  "signal.opened",
  "signal.resolved",
  "health.bandChanged",
];
