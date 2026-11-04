import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { brokenAfterDaysSchema, promiseStatus } from "../status";

/**
 * Rule 2 (M9): a promise's status is computed by code from dates and fulfilment evidence — the
 * model only proposes the promise. D1: Open / Kept (with evidence) / Late / Broken (late by
 * `brokenAfterDays`, default 14).
 */
const base = {
  dueDate: "2026-10-24",
  today: "2026-11-02",
  evidence: null,
  brokenAfterDays: 14,
} as const;

describe("promiseStatus", () => {
  it("no due date: open, and the reason says why it cannot be late", () => {
    const r = promiseStatus({ ...base, dueDate: null });
    expect(r.status).toBe("OPEN");
    expect(r.reason).toMatch(/no due date/i);
  });

  it("due in the future or today: open", () => {
    expect(promiseStatus({ ...base, dueDate: "2026-11-05" }).status).toBe("OPEN");
    const today = promiseStatus({ ...base, dueDate: "2026-11-02" });
    expect(today.status).toBe("OPEN");
    expect(today.reason).toMatch(/due today/i);
  });

  it("the day after the due date it is late, saying how many days", () => {
    const r = promiseStatus({ ...base, dueDate: "2026-11-01" });
    expect(r).toMatchObject({ status: "LATE", daysLate: 1 });
    expect(r.reason).toMatch(/1 day late/);
  });

  it("Halden: due October 24, seen on 2026-11-02, is 9 days late", () => {
    expect(promiseStatus(base)).toMatchObject({ status: "LATE", daysLate: 9 });
  });

  it("broken at exactly brokenAfterDays late, late the day before", () => {
    expect(promiseStatus({ ...base, today: addDays("2026-10-24", 13) }).status).toBe("LATE");
    expect(promiseStatus({ ...base, today: addDays("2026-10-24", 14) }).status).toBe("BROKEN");
    expect(promiseStatus({ ...base, today: addDays("2026-10-24", 40) })).toMatchObject({
      status: "BROKEN",
      daysLate: 40,
    });
  });

  it("brokenAfterDays is a setting, not a constant", () => {
    expect(promiseStatus({ ...base, today: "2026-10-31", brokenAfterDays: 7 }).status).toBe(
      "BROKEN",
    );
    expect(promiseStatus({ ...base, today: "2026-10-31", brokenAfterDays: 8 }).status).toBe("LATE");
  });

  it("evidence makes it kept, whatever the date, and names the evidence", () => {
    const r = promiseStatus({
      ...base,
      evidence: { type: "Ticket", id: "t1", date: "2026-10-23" },
    });
    expect(r.status).toBe("KEPT");
    expect(r.sources).toContainEqual({ sourceType: "Ticket", sourceId: "t1" });
    expect(r.reason).toMatch(/Ticket/);
  });

  it("kept late says so: evidence dated after the due date", () => {
    const r = promiseStatus({
      ...base,
      evidence: { type: "Message", id: "m9", date: "2026-10-30" },
    });
    expect(r.status).toBe("KEPT");
    expect(r.reason).toMatch(/6 days after the due date/);
  });

  it("KEPT is never returned without evidence (property over dates and settings)", () => {
    for (let due = -60; due <= 60; due += 7)
      for (const broken of [1, 7, 14, 30])
        for (const hasDue of [true, false]) {
          const r = promiseStatus({
            dueDate: hasDue ? addDays("2026-11-02", due) : null,
            today: "2026-11-02",
            evidence: null,
            brokenAfterDays: broken,
          });
          expect(r.status).not.toBe("KEPT");
        }
  });

  it("a promise with no date is never late or broken, however old", () => {
    expect(promiseStatus({ ...base, dueDate: null, today: "2030-01-01" }).status).toBe("OPEN");
  });
});

describe("brokenAfterDaysSchema", () => {
  it("accepts 1–365 whole days", () => {
    expect(brokenAfterDaysSchema.parse(14)).toBe(14);
    expect(brokenAfterDaysSchema.safeParse(0).success).toBe(false);
    expect(brokenAfterDaysSchema.safeParse(366).success).toBe(false);
    expect(brokenAfterDaysSchema.safeParse(1.5).success).toBe(false);
  });
});
