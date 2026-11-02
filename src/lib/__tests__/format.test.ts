import { describe, expect, it } from "vitest";
import { formatCalendarDate, formatDate } from "../format";

describe("date display", () => {
  it("shows a calendar date as the same day in every time zone", () => {
    // "2027-04-01" from a form, CSV or the renewal question is stored at UTC midnight.
    const renewal = new Date("2027-04-01");
    expect(formatCalendarDate(renewal)).toBe("Apr 1, 2027");
    // The bug this replaces: as a moment in New York it is still March 31.
    expect(formatDate(renewal, "America/New_York")).toBe("Mar 31, 2027");
  });

  it("shows nothing as a dash", () => {
    expect(formatCalendarDate(null)).toBe("—");
  });
});
