import { Redis } from "ioredis";
import { env } from "@/lib/config/env";
import { pingDatabase } from "@/lib/db/health";
import { workerHeartbeatKey, workerHeartbeatStatus, type WorkerHeartbeat } from "./heartbeat";

/**
 * What GET /api/health reports (M12 B4): database and Redis decide the status code; the worker is
 * reported, never decisive. Nothing here names a host, a credential or a version.
 */
export interface HealthReport {
  status: "ok" | "unavailable";
  db: "ok" | "fail";
  redis: "ok" | "fail";
  worker: WorkerHeartbeat;
  release?: string;
}

export interface HealthDeps {
  db: () => Promise<void>;
  /** The stored heartbeat string (or null); throws when Redis is unreachable. */
  heartbeat: () => Promise<string | null>;
  now: () => number;
}

const TIMEOUT_MS = 2_000;
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref(),
    ),
  ]);

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const [db, hb] = await Promise.allSettled([
    withTimeout(deps.db()),
    withTimeout(deps.heartbeat()),
  ]);
  const dbOk = db.status === "fulfilled";
  const redisOk = hb.status === "fulfilled";
  const release = process.env.APP_RELEASE?.trim();
  return {
    status: dbOk && redisOk ? "ok" : "unavailable",
    db: dbOk ? "ok" : "fail",
    redis: redisOk ? "ok" : "fail",
    worker: workerHeartbeatStatus(redisOk ? hb.value : null, deps.now()),
    ...(release ? { release } : {}),
  };
}

let client: Redis | undefined;
function redis(): Redis {
  client ??= new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: 1,
    commandTimeout: TIMEOUT_MS,
    connectTimeout: TIMEOUT_MS,
  });
  return client;
}

export const defaultHealthDeps: HealthDeps = {
  db: pingDatabase,
  heartbeat: () => redis().get(workerHeartbeatKey()),
  now: Date.now,
};
