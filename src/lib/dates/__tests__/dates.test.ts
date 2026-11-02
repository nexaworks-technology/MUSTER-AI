import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarDateOf,
  daysBetween,
  fixedClock,
  isOnOrBefore,
  localDate,
  startOfLocalDay,
  todayIn,
  utcMidnight,
} from "../index";

/**
 * D-50 and M3 rule 7: calendar maths in the workspace's time zone, never the server's.
 * Every case runs in UTC, Asia/Kolkata (+05:30, no DST) and America/New_York (DST ends
 * 2026-11-01), with an injected clock.
 */
describe("local calendar dates", () => {
  it("turns a moment into the workspace's own date", () => {
    // 2026-11-01T18:45Z is 00:15 on Nov 2 in Kolkata, still Nov 1 in UTC and New York.
    const m = new Date("2026-11-01T18:45:00Z");
    expect(localDate(m, "UTC")).toBe("2026-11-01");
    expect(localDate(m, "Asia/Kolkata")).toBe("2026-11-02");
    expect(localDate(m, "America/New_York")).toBe("2026-11-01");
    // 03:30Z on Nov 2 is still Nov 1 in New York (23:30 EST).
    expect(localDate(new Date("2026-11-02T03:30:00Z"), "America/New_York")).toBe("2026-11-01");
  });

  it("reads a stored calendar field as its own day in every zone (D-50)", () => {
    const renewal = new Date("2027-04-01T00:00:00Z");
    expect(calendarDateOf(renewal)).toBe("2027-04-01");
    expect(utcMidnight("2027-04-01").toISOString()).toBe("2027-04-01T00:00:00.000Z");
  });

  it("finds the first instant of a local day, including the DST change day", () => {
    expect(startOfLocalDay("2026-11-02", "UTC").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(startOfLocalDay("2026-11-02", "Asia/Kolkata").toISOString()).toBe(
      "2026-11-01T18:30:00.000Z",
    );
    // New York: Nov 1 starts in EDT (-4); Nov 2 starts in EST (-5).
    expect(startOfLocalDay("2026-11-01", "America/New_York").toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(startOfLocalDay("2026-11-02", "America/New_York").toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it("decides 'on or before the as-of date' by the local day", () => {
    const lateKolkata = new Date("2026-11-01T18:20:00Z"); // 23:50 Nov 1 in Kolkata
    const earlyKolkata = new Date("2026-11-01T18:40:00Z"); // 00:10 Nov 2 in Kolkata
    expect(isOnOrBefore(lateKolkata, "2026-11-01", "Asia/Kolkata")).toBe(true);
    expect(isOnOrBefore(earlyKolkata, "2026-11-01", "Asia/Kolkata")).toBe(false);
    expect(isOnOrBefore(earlyKolkata, "2026-11-01", "UTC")).toBe(true);
    const nyLate = new Date("2026-11-02T04:59:00Z"); // 23:59 Nov 1 EST
    expect(isOnOrBefore(nyLate, "2026-11-01", "America/New_York")).toBe(true);
    expect(isOnOrBefore(new Date("2026-11-02T05:00:00Z"), "2026-11-01", "America/New_York")).toBe(
      false,
    );
  });

  it("counts calendar days, not 24-hour blocks, across the DST change", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetween("2026-11-02", "2026-10-31")).toBe(-2);
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(addDays("2026-11-02", -14)).toBe("2026-10-19");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("reads today from an injected clock, in the workspace's zone", () => {
    const clock = fixedClock("2026-11-02T20:00:00Z");
    expect(todayIn("UTC", clock)).toBe("2026-11-02");
    expect(todayIn("Asia/Kolkata", clock)).toBe("2026-11-03");
    expect(todayIn("America/New_York", clock)).toBe("2026-11-02");
  });

  it("rejects a malformed calendar date", () => {
    expect(() => daysBetween("2026-13-01", "2026-11-02")).toThrow();
    expect(() => addDays("2026-11-2", 1)).toThrow();
  });
});
