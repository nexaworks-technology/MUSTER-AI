import { describe, expect, it } from "vitest";
import { checkDeadPlay, type DeadPlayCheckInput } from "../dead-play";

describe("S11: Dead Play Detection (spec §2, M8)", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const thirtyOneDaysAgo = new Date("2026-10-04T12:00:00Z");
  const tenDaysAgo = new Date("2026-10-25T12:00:00Z");
  const sixtyDaysAgo = new Date("2026-09-05T12:00:00Z");

  it("non-published plays (DRAFT, PAUSED, KILLED) are never flagged as dead", () => {
    const draft: DeadPlayCheckInput = {
      status: "DRAFT",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: null,
      totalEntries: 0,
      now,
    };
    expect(checkDeadPlay(draft).isDead).toBe(false);

    const paused: DeadPlayCheckInput = {
      status: "PAUSED",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: sixtyDaysAgo,
      totalEntries: 5,
      now,
    };
    expect(checkDeadPlay(paused).isDead).toBe(false);

    const killed: DeadPlayCheckInput = {
      status: "KILLED",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: sixtyDaysAgo,
      totalEntries: 2,
      now,
    };
    expect(checkDeadPlay(killed).isDead).toBe(false);
  });

  it("newly published play (< 30 days) is not flagged as dead even with 0 entries", () => {
    const res = checkDeadPlay({
      status: "PUBLISHED",
      publishedAt: tenDaysAgo,
      lastEntryAt: null,
      totalEntries: 0,
      now,
    });
    expect(res.isDead).toBe(false);
  });

  it("published play with 0 entries over window (30+ days) is flagged as NEVER_FIRED", () => {
    const res = checkDeadPlay({
      status: "PUBLISHED",
      publishedAt: thirtyOneDaysAgo,
      lastEntryAt: null,
      totalEntries: 0,
      now,
    });
    expect(res.isDead).toBe(true);
    expect(res.reason).toBe("NEVER_FIRED");
    expect(res.message).toContain("never fired");
  });

  it("published play with entries in the past but none in the last 30 days is flagged as NO_ENTRIES_IN_WINDOW", () => {
    const res = checkDeadPlay({
      status: "PUBLISHED",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: thirtyOneDaysAgo,
      totalEntries: 14,
      now,
    });
    expect(res.isDead).toBe(true);
    expect(res.reason).toBe("NO_ENTRIES_IN_WINDOW");
    expect(res.message).toContain("no entries in the last");
  });

  it("published play with active entries in the last 30 days is healthy (not dead)", () => {
    const res = checkDeadPlay({
      status: "PUBLISHED",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: tenDaysAgo,
      totalEntries: 42,
      now,
    });
    expect(res.isDead).toBe(false);
  });

  it("dead play detection is pure and never auto-kills or mutates state", () => {
    const input: DeadPlayCheckInput = {
      status: "PUBLISHED",
      publishedAt: sixtyDaysAgo,
      lastEntryAt: thirtyOneDaysAgo,
      totalEntries: 10,
      now,
    };
    const inputCopy = JSON.parse(JSON.stringify(input));
    const res = checkDeadPlay(input);
    expect(res.isDead).toBe(true);
    expect(input.status).toBe("PUBLISHED"); // status unmodified
    expect(JSON.stringify(input)).toBe(JSON.stringify(inputCopy));
  });
});
