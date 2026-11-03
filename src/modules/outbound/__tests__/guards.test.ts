import { describe, expect, it } from "vitest";
import { evaluateGuards, GUARDS, type GuardContext } from "../guards";

/**
 * All 8 auto-send guards (ARCHITECTURE §7.4; spec §6J4's six are guards 1–6), each in isolation,
 * with the boundaries M4 §5 names. A context where every guard passes is the baseline; each case
 * changes exactly one input.
 */
const H = 3_600_000;
// Tuesday 2026-11-03 15:00 in New York (20:00 UTC): inside working hours there.
const now = new Date("2026-11-03T20:00:00Z");

const base = (): GuardContext => ({
  now,
  contact: { email: "maya@brightwell.test", timezone: "America/New_York", status: "ACTIVE" },
  account: { timezone: "America/Chicago", lifecycleStage: "MATURE" },
  lastSentToContactAt: null,
  lastOtherSendToAccountAt: null,
  openSeriousTicketIds: [],
  sensitive: { isSensitive: false, reasons: [] },
  suppression: null,
  autoSendEnabled: true, // simulated config: M4 forces it off in settings
  quiet: { startHour: 19, endHour: 8, weekends: true },
  contactCooldownHours: 72,
  otherPlayCooldownHours: 48,
});

const failed = (ctx: GuardContext) =>
  evaluateGuards(ctx)
    .filter((g) => !g.passed)
    .map((g) => g.guard);

describe("evaluateGuards", () => {
  it("reports all 8 guards, and all pass on the clean baseline", () => {
    const results = evaluateGuards(base());
    expect(results.map((r) => r.guard)).toEqual(GUARDS);
    expect(results.every((r) => r.passed && r.detail.length > 0)).toBe(true);
  });

  describe("1 · contact emailed in the last 3 days", () => {
    it("2 days 23 hours ago → fails", () => {
      expect(failed({ ...base(), lastSentToContactAt: new Date(+now - 71 * H) })).toEqual([
        "contact_recently_emailed",
      ]);
    });
    it("3 days 1 hour ago → passes", () => {
      expect(failed({ ...base(), lastSentToContactAt: new Date(+now - 73 * H) })).toEqual([]);
    });
  });

  describe("2 · another play emailed the account in the last 48 hours", () => {
    it("47 hours ago → fails", () => {
      expect(failed({ ...base(), lastOtherSendToAccountAt: new Date(+now - 47 * H) })).toEqual([
        "account_recently_emailed",
      ]);
    });
    it("49 hours ago → passes", () => {
      expect(failed({ ...base(), lastOtherSendToAccountAt: new Date(+now - 49 * H) })).toEqual([]);
    });
  });

  describe("3 · quiet hours in the customer's time zone", () => {
    it("uses the contact's zone first: 20:00 UTC is 15:00 in New York → passes", () => {
      expect(failed(base())).toEqual([]);
    });
    it("late evening in the contact's zone → fails", () => {
      const ctx = { ...base(), contact: { ...base().contact, timezone: "Asia/Kolkata" } }; // 01:30
      expect(failed(ctx)).toEqual(["quiet_hours"]);
    });
    it("falls back to the account's zone when the contact has none", () => {
      const ctx = {
        ...base(),
        contact: { ...base().contact, timezone: null },
        account: { ...base().account, timezone: "Asia/Tokyo" }, // 05:00 Wednesday
      };
      expect(failed(ctx)).toEqual(["quiet_hours"]);
    });
    it("unknown time zone → hold for approval", () => {
      const ctx = {
        ...base(),
        contact: { ...base().contact, timezone: null },
        account: { ...base().account, timezone: null },
      };
      const g = evaluateGuards(ctx).find((r) => r.guard === "quiet_hours")!;
      expect(g).toMatchObject({ passed: false, detail: expect.stringMatching(/unknown/i) });
    });
    it("an invalid time zone name counts as unknown → hold", () => {
      const ctx = { ...base(), contact: { ...base().contact, timezone: "Mars/Olympus" } };
      expect(failed(ctx)).toEqual(["quiet_hours"]);
    });
    it("weekends are quiet when configured", () => {
      const saturday = new Date("2026-11-07T17:00:00Z"); // 12:00 in New York
      expect(failed({ ...base(), now: saturday })).toEqual(["quiet_hours"]);
      expect(
        failed({ ...base(), now: saturday, quiet: { ...base().quiet, weekends: false } }),
      ).toEqual([]);
    });
  });

  it("4 · an open HIGH/URGENT or escalated ticket → hold", () => {
    expect(failed({ ...base(), openSeriousTicketIds: ["t1"] })).toEqual(["serious_ticket_open"]);
  });

  it("5 · a LOST account → never", () => {
    expect(failed({ ...base(), account: { ...base().account, lifecycleStage: "LOST" } })).toEqual([
      "account_lost",
    ]);
  });

  it("6 · a sensitive topic never auto-sends, even when every other guard passes and the switch is on", () => {
    const ctx = { ...base(), sensitive: { isSensitive: true, reasons: ["cancellation"] } };
    expect(ctx.autoSendEnabled).toBe(true);
    expect(failed(ctx)).toEqual(["sensitive_topic"]);
    expect(evaluateGuards(ctx).find((r) => r.guard === "sensitive_topic")!.detail).toContain(
      "cancellation",
    );
  });

  describe("7 · suppression", () => {
    it("an unsubscribed or bounced address → never", () => {
      expect(failed({ ...base(), suppression: { reason: "UNSUBSCRIBED" } })).toEqual([
        "suppressed",
      ]);
    });
    it("a contact whose email bounced or who left → never", () => {
      for (const status of ["BOUNCED", "LEFT"] as const)
        expect(failed({ ...base(), contact: { ...base().contact, status } })).toEqual([
          "suppressed",
        ]);
    });
    it("a contact with no email address → never", () => {
      expect(failed({ ...base(), contact: { ...base().contact, email: null } })).toEqual([
        "suppressed",
      ]);
    });
  });

  it("8 · the auto-send kill switch off → never auto", () => {
    expect(failed({ ...base(), autoSendEnabled: false })).toEqual(["auto_send_disabled"]);
  });

  it("is pure: the same context gives the same results", () => {
    expect(evaluateGuards(base())).toEqual(evaluateGuards(base()));
  });
});
