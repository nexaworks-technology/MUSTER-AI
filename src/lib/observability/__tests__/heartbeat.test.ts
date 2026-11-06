import { describe, expect, it } from "vitest";
import { WORKER_STALE_AFTER_SECONDS, workerHeartbeatStatus } from "../heartbeat";

describe("workerHeartbeatStatus", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  it("is ok within the stale window", () => {
    const s = workerHeartbeatStatus(String(now - 30_000), now);
    expect(s).toEqual({ lastHeartbeatAt: "2026-11-06T11:59:30.000Z", ageSeconds: 30, ok: true });
  });
  it("is stale past 90 seconds", () => {
    expect(WORKER_STALE_AFTER_SECONDS).toBe(90);
    expect(workerHeartbeatStatus(String(now - 91_000), now).ok).toBe(false);
    expect(workerHeartbeatStatus(String(now - 90_000), now).ok).toBe(true);
  });
  it("reports no heartbeat as stale with nulls, and treats junk as no heartbeat", () => {
    const none = { lastHeartbeatAt: null, ageSeconds: null, ok: false };
    expect(workerHeartbeatStatus(null, now)).toEqual(none);
    expect(workerHeartbeatStatus("garbage", now)).toEqual(none);
  });
});
