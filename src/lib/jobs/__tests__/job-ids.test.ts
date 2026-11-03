import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backtestJobId, manualRunId, realtimeRunId } from "../ids";

/**
 * Uniqueness-intended ids (Q-49 round 4, D-81): every request must produce a job, so these ids
 * never come from the business clock. With it frozen (the e2e harness), thousands of calls in one
 * instant still give thousands of distinct ids.
 */
const saved = { allow: process.env.ALLOW_FAKE_CLOCK, now: process.env.APP_FAKE_NOW };
beforeAll(() => {
  process.env.ALLOW_FAKE_CLOCK = "true";
  process.env.APP_FAKE_NOW = "2026-11-02T17:00:00Z";
});
afterAll(() => {
  if (saved.allow === undefined) delete process.env.ALLOW_FAKE_CLOCK;
  else process.env.ALLOW_FAKE_CLOCK = saved.allow;
  if (saved.now === undefined) delete process.env.APP_FAKE_NOW;
  else process.env.APP_FAKE_NOW = saved.now;
});

describe("uniqueness-intended id builders under a frozen business clock", () => {
  const distinct = (build: () => string, n = 2_000) =>
    new Set(Array.from({ length: n }, build)).size;

  it("manual kickoff run ids are distinct on every call", () => {
    expect(distinct(manualRunId)).toBe(2_000);
  });

  it("back-test job ids are distinct on every call", () => {
    expect(distinct(() => backtestJobId("ws_1"))).toBe(2_000);
  });

  it("real-time hook run ids are distinct on every call", () => {
    expect(distinct(() => realtimeRunId("pulse set"))).toBe(2_000);
  });

  it("ids are built from real time, not the pinned business instant", () => {
    const stamp = Number(/^manual-(\d+)-/.exec(manualRunId())![1]);
    expect(stamp).toBeGreaterThan(Date.parse("2026-11-03T00:00:00Z"));
    expect(stamp).not.toBe(Date.parse("2026-11-02T17:00:00Z"));
  });

  it("keep the shapes the pipeline expects", () => {
    expect(manualRunId()).toMatch(/^manual-\d+-[0-9a-f]{8}$/);
    expect(realtimeRunId("pulse set / x")).toMatch(/^rt-pulse-set---x-\d+-[0-9a-f]{8}$/);
    expect(backtestJobId("ws_1")).toMatch(/^ws_1\.backtest\.\d+-[0-9a-f]{8}$/);
    for (const id of [manualRunId(), realtimeRunId("a".repeat(80))])
      expect(id).toMatch(/^[\w-]{1,80}$/);
  });
});
