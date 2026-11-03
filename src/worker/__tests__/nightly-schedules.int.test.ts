import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/config/env";
import { closeQueues, getQueue } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { syncNightlySchedules } from "../processors";

/**
 * NIGHTLY_SCHEDULES (Q-49): with the flag off the worker registers no per-workspace nightly
 * schedules, so a real-clock nightly run can never rewrite the seeded demo workspace under e2e;
 * unset (the default, production) registers them as before. Both directions, plus the e2e config.
 */
const KEY = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const base = {
  DATABASE_URL: "postgresql://app_user:x@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(40),
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "s",
  FIELD_ENCRYPTION_KEY: KEY,
};

let workspaceId: string;
afterAll(async () => {
  if (workspaceId) await getQueue("signals").removeJobScheduler(`nightly-${workspaceId}`);
  await closeQueues();
});

describe("nightly schedule registration", () => {
  it("registers nothing with the flag off", async () => {
    ({
      workspace: { id: workspaceId },
    } = await createTestAdmin("NightlyOff"));
    expect(await syncNightlySchedules({ enabled: false })).toBe(0);
    expect(await getQueue("signals").getJobScheduler(`nightly-${workspaceId}`)).toBeUndefined();
  });

  it("registers the workspace's schedule at 02:00 in its time zone with the flag unset (default)", async () => {
    expect(await syncNightlySchedules()).toBeGreaterThanOrEqual(1);
    const scheduler = await getQueue("signals").getJobScheduler(`nightly-${workspaceId}`);
    expect(scheduler).toMatchObject({ pattern: "0 2 * * *", name: "nightly.kickoff" });
  });

  it("the env flag defaults to on and accepts only on or off", () => {
    expect(parseEnv(base).NIGHTLY_SCHEDULES).toBe("on");
    expect(parseEnv({ ...base, NIGHTLY_SCHEDULES: "off" }).NIGHTLY_SCHEDULES).toBe("off");
    expect(() => parseEnv({ ...base, NIGHTLY_SCHEDULES: "never" })).toThrow();
  });

  it("only the e2e worker turns it off: the e2e config sets it, the web server and everything else do not", () => {
    const cfg = readFileSync(path.join(process.cwd(), "playwright.config.ts"), "utf8");
    expect(cfg.match(/NIGHTLY_SCHEDULES:\s*"off"/g)).toHaveLength(1);
    const worker = cfg.slice(cfg.indexOf("src/worker/index.ts"));
    expect(worker).toContain('NIGHTLY_SCHEDULES: "off"');
    expect(cfg.slice(0, cfg.indexOf("src/worker/index.ts"))).not.toContain("NIGHTLY_SCHEDULES");
  });
});
