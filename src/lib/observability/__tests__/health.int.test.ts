import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { env } from "@/lib/config/env";
import { queuePrefix } from "@/lib/jobs/queues";
import { closeRateLimit } from "@/lib/rate-limit";
import { workerHeartbeatKey } from "../heartbeat";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.77" }),
}));

import { GET } from "@/app/api/health/route";

/** M12 B4 — GET /api/health against the real database and Redis. */
const redis = new Redis(env().REDIS_URL);
const get = () =>
  GET(
    new Request("http://localhost/api/health", { headers: { "x-forwarded-for": "198.51.100.77" } }),
  );

beforeEach(async () => {
  await redis.del(workerHeartbeatKey());
});
afterAll(async () => {
  await redis.del(workerHeartbeatKey());
  redis.disconnect();
  await closeRateLimit();
});

describe("GET /api/health", () => {
  it("is 200 with db and redis ok, and says the worker is stale when it has never beaten", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      db: "ok",
      redis: "ok",
      worker: { lastHeartbeatAt: null, ageSeconds: null, ok: false },
    });
    expect(JSON.stringify(body)).not.toContain(env().REDIS_URL);
  });

  it("reports a fresh heartbeat as ok and an old one as stale (web stays 200)", async () => {
    await redis.set(workerHeartbeatKey(), String(Date.now() - 5_000), "EX", 300);
    let body = await (await get()).json();
    expect(body.worker.ok).toBe(true);
    expect(body.worker.ageSeconds).toBeGreaterThanOrEqual(5);

    await redis.set(workerHeartbeatKey(), String(Date.now() - 200_000), "EX", 300);
    const res = await get();
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body.worker.ok).toBe(false);
    expect(body.worker.ageSeconds).toBeGreaterThan(90);
  });

  it("keeps the heartbeat under the queue prefix", () => {
    expect(workerHeartbeatKey().startsWith(`${queuePrefix()}:`)).toBe(true);
  });
});
