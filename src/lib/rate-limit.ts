import { Redis } from "ioredis";
import { env } from "@/lib/config/env";
import { queuePrefix } from "@/lib/jobs/queues";

/**
 * Fixed-window rate limit in Redis: one counter per (key, window). Windows are real time, never
 * the business clock. Redis being unreachable is an error the caller turns into "try again":
 * an endpoint that needs a limit never runs unthrottled.
 */
export interface RateLimit {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

let client: Redis | undefined;

function redis(): Redis {
  client ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: 2 });
  return client;
}

export async function hitRateLimit(
  key: string,
  { limit, windowSeconds }: RateLimit,
  now: Date = new Date(),
  r: Pick<Redis, "incr" | "expire"> = redis(),
): Promise<RateLimitResult> {
  const nowSeconds = now.getTime() / 1000;
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const counter = `${queuePrefix()}:rl:${key}:${bucket}`;
  const used = await r.incr(counter);
  if (used === 1) await r.expire(counter, windowSeconds + 1);
  return {
    allowed: used <= limit,
    limit,
    remaining: Math.max(0, limit - used),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket + 1) * windowSeconds - nowSeconds)),
  };
}

/** Reads the current window's count without counting (M12 A9: the 401 IP block). */
export async function peekRateLimit(
  key: string,
  { windowSeconds }: RateLimit,
  now: Date = new Date(),
  r: Pick<Redis, "get"> = redis(),
): Promise<{ used: number; retryAfterSeconds: number }> {
  const nowSeconds = now.getTime() / 1000;
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const used = Number((await r.get(`${queuePrefix()}:rl:${key}:${bucket}`)) ?? 0);
  return {
    used,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket + 1) * windowSeconds - nowSeconds)),
  };
}

export async function closeRateLimit(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = undefined;
}
