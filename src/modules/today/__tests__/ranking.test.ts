import { describe, expect, it } from "vitest";
import { moneyWeight, rankItems, urgencyOf, type Candidate } from "../ranking";

/**
 * Today ranking (ARCHITECTURE §9, spec §6F1): rankScore = moneyWeight × urgency, both from code,
 * with reasons. Ties break by renewal date, then account name. Without revenue access the order is
 * the same and the reasons name no ARR.
 */
const TODAY = "2026-11-02";
const c = (o: Partial<Candidate> & Pick<Candidate, "refId">): Candidate => ({
  itemType: "TASK",
  title: o.refId,
  accountId: "a",
  accountName: "Acme",
  arrMinor: 0n,
  currency: "USD",
  renewalDate: null,
  driver: { kind: "TASK_DUE", dueDate: TODAY },
  ...o,
});

describe("moneyWeight", () => {
  it("is 1 + log10(1 + ARR in thousands)", () => {
    expect(moneyWeight(0n)).toBe(1);
    expect(moneyWeight(99_000_00n)).toBe(3); // $99,000 → 1 + log10(100)
    expect(moneyWeight(null)).toBe(1);
  });
});

describe("urgency drivers", () => {
  it("overdue tasks grow 0.1 a day from 1.0, capped at 2.0", () => {
    expect(urgencyOf({ kind: "TASK_DUE", dueDate: "2026-11-01" }, TODAY)).toBeCloseTo(1.1);
    expect(urgencyOf({ kind: "TASK_DUE", dueDate: "2026-10-31" }, TODAY)).toBeCloseTo(1.2);
    expect(urgencyOf({ kind: "TASK_DUE", dueDate: "2026-09-01" }, TODAY)).toBe(2);
  });
  it("due today 0.8; CRITICAL 0.9, WARN 0.5; renewal 0.9 / 0.6 / 0.4; approval > 24 h 0.7", () => {
    expect(urgencyOf({ kind: "TASK_DUE", dueDate: TODAY }, TODAY)).toBe(0.8);
    expect(urgencyOf({ kind: "SIGNAL", severity: "CRITICAL" }, TODAY)).toBe(0.9);
    expect(urgencyOf({ kind: "SIGNAL", severity: "WARN" }, TODAY)).toBe(0.5);
    expect(urgencyOf({ kind: "RENEWAL", renewalDate: "2026-11-20" }, TODAY)).toBe(0.9);
    expect(urgencyOf({ kind: "RENEWAL", renewalDate: "2026-12-20" }, TODAY)).toBe(0.6);
    expect(urgencyOf({ kind: "RENEWAL", renewalDate: "2027-01-25" }, TODAY)).toBe(0.4);
    expect(urgencyOf({ kind: "APPROVAL", waitingHours: 30 }, TODAY)).toBe(0.7);
    expect(urgencyOf({ kind: "APPROVAL", waitingHours: 3 }, TODAY)).toBe(0.5);
  });
});

describe("rankItems", () => {
  it("orders by money × urgency", () => {
    const ranked = rankItems(
      [
        c({
          refId: "small-overdue",
          arrMinor: 1_000_00n,
          driver: { kind: "TASK_DUE", dueDate: "2026-10-31" },
        }),
        c({ refId: "big-today", arrMinor: 142_000_00n }),
        c({
          refId: "big-critical",
          arrMinor: 142_000_00n,
          itemType: "SIGNAL",
          driver: { kind: "SIGNAL", severity: "CRITICAL" },
        }),
      ],
      { today: TODAY, canViewRevenue: true },
    );
    expect(ranked.map((r) => r.refId)).toEqual(["big-critical", "big-today", "small-overdue"]);
    expect(ranked[0]!.rankScore).toBeCloseTo(0.9 * (1 + Math.log10(143)), 6);
  });

  it("shows why, in words: ARR × the driver", () => {
    const [r] = rankItems(
      [
        c({
          refId: "t",
          arrMinor: 142_000_00n,
          driver: { kind: "TASK_DUE", dueDate: "2026-10-31" },
        }),
      ],
      {
        today: TODAY,
        canViewRevenue: true,
      },
    );
    expect(r!.rankReasons).toEqual([
      { kind: "money", label: "$142k ARR" },
      { kind: "urgency", label: "overdue 2 days" },
    ]);
  });

  it("without revenue access the order is identical and no ARR is shown", () => {
    const items = [
      c({ refId: "x", arrMinor: 142_000_00n }),
      c({ refId: "y", arrMinor: 9_000_00n, driver: { kind: "TASK_DUE", dueDate: "2026-10-31" } }),
    ];
    const withRev = rankItems(items, { today: TODAY, canViewRevenue: true });
    const without = rankItems(items, { today: TODAY, canViewRevenue: false });
    expect(without.map((r) => [r.refId, r.rankScore])).toEqual(
      withRev.map((r) => [r.refId, r.rankScore]),
    );
    expect(JSON.stringify(without.map((r) => r.rankReasons))).not.toMatch(/\$|ARR/);
    expect(without[0]!.rankReasons[0]).toEqual({ kind: "money", label: "Account value" });
  });

  it("breaks ties by renewal date (soonest first, none last), then account name", () => {
    const ranked = rankItems(
      [
        c({ refId: "no-renewal", accountName: "Aardvark" }),
        c({ refId: "later", accountName: "Zed", renewalDate: "2027-03-01" }),
        c({ refId: "sooner-b", accountName: "Beta", renewalDate: "2027-01-01" }),
        c({ refId: "sooner-a", accountName: "Alpha", renewalDate: "2027-01-01" }),
      ],
      { today: TODAY, canViewRevenue: true },
    );
    expect(ranked.map((r) => r.refId)).toEqual(["sooner-a", "sooner-b", "later", "no-renewal"]);
  });

  it("is deterministic: the same input gives the same order", () => {
    const items = [c({ refId: "a" }), c({ refId: "b" }), c({ refId: "c", arrMinor: 5n })];
    expect(rankItems(items, { today: TODAY, canViewRevenue: true })).toEqual(
      rankItems([...items].reverse(), { today: TODAY, canViewRevenue: true }),
    );
  });
});

describe("an overdue renewal (DEMO-WALKTHROUGH FAIL 29)", () => {
  it("keeps the top renewal urgency and says overdue, not a negative count", () => {
    const driver = { kind: "RENEWAL" as const, renewalDate: "2026-10-21" };
    expect(urgencyOf(driver, TODAY)).toBe(0.9);
    const [r] = rankItems([c({ refId: "q", itemType: "RENEWAL", driver })], {
      today: TODAY,
      canViewRevenue: false,
    });
    expect(r!.rankReasons).toContainEqual({ kind: "urgency", label: "renewal overdue by 12 days" });
  });
});
