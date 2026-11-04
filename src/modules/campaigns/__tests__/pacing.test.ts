import { describe, expect, it } from "vitest";
import {
  calculateRecipientSchedule,
  computeRecipientBatches,
  getIntervalBetweenRecipientsMs,
} from "../pacing";

describe("S14 Campaign Pacing (Pure Module)", () => {
  const baseTime = new Date("2026-11-04T12:00:00.000Z");

  it("calculates correct interval between recipients based on pacePerHour", () => {
    // 60 emails/hr = 1 email every 60 seconds (60,000 ms)
    expect(getIntervalBetweenRecipientsMs(60)).toBe(60_000);
    // 100 emails/hr = 1 email every 36 seconds (36,000 ms)
    expect(getIntervalBetweenRecipientsMs(100)).toBe(36_000);
    // 120 emails/hr = 1 email every 30 seconds (30,000 ms)
    expect(getIntervalBetweenRecipientsMs(120)).toBe(30_000);
    // 3600 emails/hr = 1 email every 1 second (1,000 ms)
    expect(getIntervalBetweenRecipientsMs(3600)).toBe(1_000);
  });

  it("clamps invalid pacePerHour to safe defaults", () => {
    expect(getIntervalBetweenRecipientsMs(0)).toBe(36_000); // defaults to 100/hr
    expect(getIntervalBetweenRecipientsMs(-10)).toBe(36_000);
  });

  it("calculates individual recipient scheduled times evenly across the pacing window", () => {
    const schedules = calculateRecipientSchedule({
      count: 5,
      scheduledAt: baseTime,
      pacePerHour: 60, // 1 per minute
    });

    expect(schedules).toHaveLength(5);
    expect(schedules[0]!.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect(schedules[1]!.toISOString()).toBe("2026-11-04T12:01:00.000Z");
    expect(schedules[2]!.toISOString()).toBe("2026-11-04T12:02:00.000Z");
    expect(schedules[3]!.toISOString()).toBe("2026-11-04T12:03:00.000Z");
    expect(schedules[4]!.toISOString()).toBe("2026-11-04T12:04:00.000Z");
  });

  it("distributes 100 recipients over exactly one hour", () => {
    const schedules = calculateRecipientSchedule({
      count: 100,
      scheduledAt: baseTime,
      pacePerHour: 100,
    });

    expect(schedules).toHaveLength(100);
    expect(schedules[0]!.getTime()).toBe(baseTime.getTime());
    // 99th recipient (index 99) is at 99 * 36,000 ms = 3,564,000 ms (59m 24s)
    expect(schedules[99]!.getTime()).toBe(baseTime.getTime() + 99 * 36_000);
  });

  it("partitions recipients into hourly batches for background processing", () => {
    const recipientIds = Array.from({ length: 150 }, (_, i) => `recip-${i}`);
    const batches = computeRecipientBatches({
      recipientIds,
      scheduledAt: baseTime,
      pacePerHour: 100,
    });

    // 150 recipients at 100/hr = 2 hourly batches (100 in first, 50 in second)
    expect(batches).toHaveLength(2);
    expect(batches[0]!.batchIndex).toBe(0);
    expect(batches[0]!.recipients).toHaveLength(100);
    expect(batches[0]!.windowStart.toISOString()).toBe("2026-11-04T12:00:00.000Z");

    expect(batches[1]!.batchIndex).toBe(1);
    expect(batches[1]!.recipients).toHaveLength(50);
    expect(batches[1]!.windowStart.toISOString()).toBe("2026-11-04T13:00:00.000Z");
  });
});
