import { describe, expect, it } from "vitest";
import type { AdoptionInput } from "@/modules/usage/service";
import { adoptionReport } from "../adoption";
import { everyFigureIsProven, fig } from "./helpers";

const catalog = [
  { featureKey: "reports", label: "Reports", isKeyFeature: true, includedInPlans: ["pro"] },
  { featureKey: "api", label: "API", isKeyFeature: false, includedInPlans: ["pro"] },
];
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
function input(
  accountId: string,
  seatsUsed: number | null,
  seatsPurchased: number | null,
  used: string[] = [],
): AdoptionInput {
  return {
    accountId,
    asOf: day(20),
    plan: "pro",
    contract:
      seatsPurchased === null
        ? null
        : { id: `c-${accountId}`, seatsPurchased, creditsPurchased: null, startDate: "2026-01-01" },
    usage:
      seatsUsed === null
        ? null
        : [{ id: `u-${accountId}`, date: day(19), activeUsers: 3, seatsUsed, creditsUsed: null }],
    userUsage: [],
    featureUsage: used.length
      ? used.map((featureKey) => ({ featureKey, date: day(19), users: 2 }))
      : null,
    catalog,
    ownNormal: null,
    cohort: null,
  };
}

describe("adoption report", () => {
  const r = adoptionReport([
    input("a1", 10, 100, ["api"]), // 10% UNDER, key feature unused
    input("a2", 80, 100, ["api", "reports"]), // OK
    input("a3", 120, 100, ["reports"]), // OVER
    input("a4", null, null), // no contract, no usage
  ]);

  it("tallies seat status per account, citing the usage rows", () => {
    expect(fig(r, "Accounts using under half their seats").sources.ids).toEqual(["u-a1"]);
    expect(fig(r, "Accounts using more seats than bought").sources.ids).toEqual(["u-a3"]);
  });

  it("sums seats in use against seats bought only over accounts that have both", () => {
    expect(fig(r, "Seats in use").value).toBe(210);
    expect(fig(r, "Seats bought (accounts with usage)").value).toBe(300);
    expect(fig(r, "Share of bought seats in use").value).toBe(70);
  });

  it("lists accounts whose key features have never been used", () => {
    expect(fig(r, "Accounts with a key feature never used").sources.ids).toEqual(["a1"]);
  });

  it("says how many accounts have no usage or contract data instead of counting them as zero use", () => {
    const f = fig(r, "Accounts with no adoption data");
    expect(f.value).toBe(1);
    expect(f.sources.ids).toEqual(["a4"]);
  });

  it("with no usable account the seat share is missing, not 0%", () => {
    const e = adoptionReport([input("a4", null, null)]);
    const f = fig(e, "Share of bought seats in use");
    expect(f.value).toBeNull();
    expect(f.reason).toMatch(/No seat data/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
