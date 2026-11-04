import { describe, expect, it } from "vitest";
import { coverage } from "../coverage";
import { moneyAtRisk, type RiskRenewal } from "../moneyAtRisk";
import { teamLoad } from "../teamLoad";

const r = (
  id: string,
  date: string,
  arr: number | null,
  band: RiskRenewal["band"],
  risk: RiskRenewal["accountRisk"],
  currency: string | null = "USD",
): RiskRenewal => ({
  id,
  accountId: `acct-${id}`,
  renewalDate: date,
  arrMinor: arr === null ? null : BigInt(arr),
  currency: arr === null ? null : currency,
  band,
  accountRisk: risk,
});

describe("moneyAtRisk", () => {
  const rows = [
    r("a", "2026-11-20", 100_00, "HIGH", "AT_RISK"),
    r("b", "2026-12-20", 50_00, "LOW", "HEALTHY"),
    r("c", "2026-12-25", 25_00, "LOW", "AT_RISK"),
    r("d", "2026-11-10", 999_00, "HIGH", "HEALTHY"),
    r("e", "2026-11-25", null, "LOW", null),
    r("f", "2026-11-25", 70_00, "LOW", "AT_RISK", "EUR"),
    r("g", "2027-03-01", 5_00, "LOW", "AT_RISK"),
  ];
  it("counts renewals in the window that are At Risk or LOW, each with its reasons", () => {
    const m90 = moneyAtRisk(rows, "2026-11-04", 90, "USD");
    expect(m90.arrMinor).toBe(175_00n);
    expect(m90.items.map((i) => [i.renewalId, i.reasons])).toEqual([
      ["a", ["ACCOUNT_AT_RISK"]],
      ["b", ["LOW_CONFIDENCE"]],
      ["c", ["ACCOUNT_AT_RISK", "LOW_CONFIDENCE"]],
      ["e", ["LOW_CONFIDENCE"]],
      ["f", ["ACCOUNT_AT_RISK", "LOW_CONFIDENCE"]],
    ]);
    expect(m90.noArrIds).toEqual(["e"]);
    expect(m90.otherCurrencies).toEqual([{ currency: "EUR", arrMinor: 70_00n, renewalIds: ["f"] }]);
  });
  it("30 days is a narrower window", () => {
    expect(moneyAtRisk(rows, "2026-11-04", 30, "USD").arrMinor).toBe(100_00n);
  });
});

describe("coverage", () => {
  const c = coverage(
    [
      { id: "1", name: "Fresh", lastTouchAt: new Date("2026-10-30T10:00:00Z") },
      { id: "2", name: "Quiet", lastTouchAt: new Date("2026-09-01T10:00:00Z") },
      { id: "3", name: "Never", lastTouchAt: null },
      { id: "4", name: "Edge", lastTouchAt: new Date("2026-10-05T10:00:00Z") },
    ],
    "2026-11-04",
  );
  it("separates silent accounts from accounts with no contact on record", () => {
    expect(c.total).toBe(4);
    expect(c.covered).toBe(2); // 30 days exactly still counts as covered
    expect(c.untouched).toEqual([{ id: "2", name: "Quiet", daysSince: 64 }]);
    expect(c.noContactRecorded).toEqual([{ id: "3", name: "Never" }]);
  });
});

describe("teamLoad", () => {
  it("sums per owner in the base currency, other currencies apart, no-ARR counted apart", () => {
    const rows = teamLoad(
      [
        { id: "1", ownerMembershipId: "m1", arrMinor: 100n, currency: "USD" },
        { id: "2", ownerMembershipId: "m1", arrMinor: 50n, currency: "EUR" },
        { id: "3", ownerMembershipId: "m1", arrMinor: null, currency: null },
        { id: "4", ownerMembershipId: null, arrMinor: 10n, currency: "USD" },
      ],
      new Map([
        ["m1", 3],
        ["m2", 1],
      ]),
      "USD",
    );
    expect(rows.find((x) => x.ownerMembershipId === "m1")).toEqual({
      ownerMembershipId: "m1",
      accounts: 3,
      arrMinor: 100n,
      accountsWithoutArr: 1,
      otherCurrencies: [{ currency: "EUR", arrMinor: 50n }],
      openTasks: 3,
    });
    expect(rows.find((x) => x.ownerMembershipId === "m2")).toMatchObject({
      accounts: 0,
      openTasks: 1,
    });
    expect(rows.find((x) => x.ownerMembershipId === null)).toMatchObject({
      accounts: 1,
      arrMinor: 10n,
    });
  });
});
