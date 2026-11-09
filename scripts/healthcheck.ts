/**
 * scripts/healthcheck.ts
 *
 * Comprehensive pre-flight and runtime health probe (NTH-1).
 * Probes:
 * 1. Database (PostgreSQL connectivity and latency)
 * 2. Redis (cache / queue connectivity)
 * 3. ClamAV (clamd daemon ping over TCP/socket)
 * 4. Background Worker (BullMQ heartbeat status in Redis)
 * 5. Web Server (GET /api/health HTTP probe, optional/skipped if web not yet up)
 *
 * Exit code: 0 if critical services are healthy; 1 if any critical check fails.
 */
import { Redis } from "ioredis";
import { pingDatabase } from "../src/lib/db/health";
import { createClamdScanner } from "../src/lib/uploads/clamd";
import { workerHeartbeatKey, workerHeartbeatStatus } from "../src/lib/observability/heartbeat";

interface CheckResult {
  name: string;
  status: "OK" | "WARN" | "FAIL" | "SKIPPED";
  detail: string;
  durationMs: number;
}

const isProd = process.env.NODE_ENV === "production";

async function timeCheck(
  name: string,
  fn: () => Promise<{ status: "OK" | "WARN" | "FAIL" | "SKIPPED"; detail: string }>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fn();
    return { name, ...res, durationMs: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: "FAIL", detail: msg, durationMs: Date.now() - start };
  }
}

async function checkDb(): Promise<{ status: "OK" | "WARN" | "FAIL"; detail: string }> {
  await pingDatabase();
  return { status: "OK", detail: "Connected and responding to queries" };
}

async function checkRedis(): Promise<{ status: "OK" | "WARN" | "FAIL"; detail: string }> {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
  });

  try {
    const pong = await client.ping();
    if (pong === "PONG") {
      return { status: "OK", detail: `Responding at ${redisUrl.replace(/:[^:@]+@/, ":***@")}` };
    }
    return { status: "FAIL", detail: `Unexpected ping response: ${pong}` };
  } finally {
    client.disconnect();
  }
}

async function checkClamAV(): Promise<{ status: "OK" | "WARN" | "FAIL" | "SKIPPED"; detail: string }> {
  const host = process.env.CLAMD_HOST;
  const port = process.env.CLAMD_PORT ? Number(process.env.CLAMD_PORT) : 3310;
  const socket = process.env.CLAMD_SOCKET;

  if (!host && !socket) {
    if (isProd) {
      return {
        status: "FAIL",
        detail: "Production requires CLAMD_HOST or CLAMD_SOCKET (Q-18)",
      };
    }
    return {
      status: "SKIPPED",
      detail: "No CLAMD_HOST or CLAMD_SOCKET configured (non-production)",
    };
  }

  const scanner = createClamdScanner({ host, port, socket, timeoutMs: 3000 });
  const ok = await scanner.ping();
  if (ok) {
    return {
      status: "OK",
      detail: `clamd active and responding PONG (${socket ? `socket: ${socket}` : `${host}:${port}`})`,
    };
  }

  return {
    status: isProd ? "FAIL" : "WARN",
    detail: `clamd unreachable or did not answer PING (${socket ? `socket: ${socket}` : `${host}:${port}`})`,
  };
}

async function checkWorker(): Promise<{ status: "OK" | "WARN" | "FAIL"; detail: string }> {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
  });

  try {
    const key = workerHeartbeatKey();
    const heartbeatStr = await client.get(key);
    const status = workerHeartbeatStatus(heartbeatStr, Date.now());

    if (status.ok) {
      return { status: "OK", detail: `Worker active (last heartbeat ${status.ageSeconds}s ago)` };
    }
    if (status.lastHeartbeatAt) {
      return { status: "WARN", detail: `Worker stale (last heartbeat ${status.ageSeconds}s ago)` };
    }
    return { status: "WARN", detail: "No worker heartbeat found in Redis" };
  } finally {
    client.disconnect();
  }
}

async function checkWeb(): Promise<{ status: "OK" | "WARN" | "FAIL" | "SKIPPED"; detail: string }> {
  const port = process.env.PORT || "3000";
  const appUrl = process.env.APP_URL || `http://localhost:${port}`;
  const healthUrl = `${appUrl}/api/health`;

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      return { status: "OK", detail: `GET ${healthUrl} status ${res.status} (${body.status ?? "ok"})` };
    }
    return { status: "WARN", detail: `GET ${healthUrl} returned status ${res.status}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "SKIPPED", detail: `Web server not responding at ${healthUrl} (${msg})` };
  }
}

async function runHealthcheck() {
  console.log(`\n=== NexaWorks CSM System Healthcheck [${new Date().toISOString()}] ===\n`);

  const results: CheckResult[] = [
    await timeCheck("Database", checkDb),
    await timeCheck("Redis", checkRedis),
    await timeCheck("ClamAV", checkClamAV),
    await timeCheck("Worker", checkWorker),
    await timeCheck("Web Server", checkWeb),
  ];

  let hasFail = false;
  for (const r of results) {
    const icon = r.status === "OK" ? "✓" : r.status === "WARN" ? "⚠" : r.status === "FAIL" ? "✗" : "○";
    console.log(`[${icon} ${r.status.padEnd(7)}] ${r.name.padEnd(12)} (${r.durationMs}ms) — ${r.detail}`);
    if (r.status === "FAIL") hasFail = true;
  }

  console.log(`\nOverall Status: ${hasFail ? "FAILED" : "PASSED"}\n`);

  if (hasFail) {
    process.exit(1);
  }
}

runHealthcheck().catch((err) => {
  console.error("Healthcheck crashed:", err);
  process.exit(1);
});
