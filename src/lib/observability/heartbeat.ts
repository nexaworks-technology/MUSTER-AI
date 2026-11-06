import type { Redis } from "ioredis";
import { queuePrefix } from "@/lib/jobs/queues";

/**
 * Worker liveness (M12 B4). The worker writes the current time under one Redis key every 30 s;
 * the web health endpoint reads it. A heartbeat older than 90 s counts as stale. The key's TTL is
 * longer than that so a stale worker still reports how stale; after the TTL it reads as "never".
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TTL_SECONDS = 300;
export const WORKER_STALE_AFTER_SECONDS = 90;

export const workerHeartbeatKey = (): string => `${queuePrefix()}:worker:heartbeat`;

export interface WorkerHeartbeat {
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  ok: boolean;
}

/** `raw` is the stored epoch-milliseconds string, or null when there is no heartbeat. */
export function workerHeartbeatStatus(raw: string | null, nowMs: number): WorkerHeartbeat {
  const at = raw !== null && /^\d{10,16}$/.test(raw) ? Number(raw) : null;
  if (at === null) return { lastHeartbeatAt: null, ageSeconds: null, ok: false };
  const ageSeconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  return {
    lastHeartbeatAt: new Date(at).toISOString(),
    ageSeconds,
    ok: ageSeconds <= WORKER_STALE_AFTER_SECONDS,
  };
}

export async function writeHeartbeat(redis: Pick<Redis, "set">, nowMs = Date.now()): Promise<void> {
  await redis.set(workerHeartbeatKey(), String(nowMs), "EX", HEARTBEAT_TTL_SECONDS);
}

/** Beats now and every 30 s; a failed beat is reported to `onError` and the next one retries. */
export function startHeartbeat(
  redis: Pick<Redis, "set">,
  onError: (err: unknown) => void,
): () => void {
  const beat = () => void writeHeartbeat(redis).catch(onError);
  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
