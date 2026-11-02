import { Queue, type ConnectionOptions } from "bullmq";
import { env } from "@/lib/config/env";

/**
 * Background queues (ARCHITECTURE §1.2). Every tenant job carries `workspaceId` in its payload
 * and its handler re-scopes with scopedDb({ workspaceId }); `maintenance` jobs are global.
 */
export const QUEUE_NAMES = [
  "sync",
  "signals",
  "health",
  "agents",
  "outbound",
  "outcomes",
  "reports",
  "maintenance",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Key prefix keeps dev, test and e2e runs from sharing queues on one Redis. */
export function queuePrefix(): string {
  return process.env.NODE_ENV === "test" ? "nexaworks-test" : "nexaworks";
}

export function redisConnection(): ConnectionOptions {
  // maxRetriesPerRequest: null is required by BullMQ workers (blocking commands).
  return { url: env().REDIS_URL, maxRetriesPerRequest: null };
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: redisConnection(),
      prefix: queuePrefix(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 86_400, count: 10_000 },
        removeOnFail: { age: 30 * 86_400 },
      },
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
