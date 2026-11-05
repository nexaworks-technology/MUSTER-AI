import { describe, expect, it } from "vitest";
import { portfolioHealthTrend, type HealthTrendInput } from "../portfolio-health-trend";
import { everyFigureIsProven, fig } from "./helpers";

const base: HealthTrendInput = {
  periodStart: "2026-10-05",
  periodEnd: "2026-10-19",
  baseCurrency: "USD",
  query: "",
  accounts: [
    {
      id: "a1",
      arrMinor: 100_00n,
      currency: "USD",
      currentSnapshotId: "s1c",
      currentRisk: "AT_RISK",
    },
    {
      id: "a2",
      arrMinor: 50_00n,
      currency: "USD",
      currentSnapshotId: "s2c",
      currentRisk: "HEALTHY",
    },
    { id: "a3", arrMinor: null, currency: null, currentSnapshotId: "s3c", currentRisk: "AT_RISK" },
    { id: "a4", arrMinor: 10_00n, currency: "USD", currentSnapshotId: null, currentRisk: null },
  ],
  snapshots: [
    { id: "s1a", accountId: "a1", asOf: "2026-10-05", riskLevel: "HEALTHY" },
    { id: "s1b", accountId: "a1", asOf: "2026-10-12", riskLevel: "WATCH" },
    { id: "s1c", accountId: "a1", asOf: "2026-10-19", riskLevel: "AT_RISK" },
    { id: "s2a", accountId: "a2", asOf: "2026-10-05", riskLevel: "AT_RISK" },
    { id: "s2c", accountId: "a2", asOf: "2026-10-19", riskLevel: "HEALTHY" },
    { id: "s3c", accountId: "a3", asOf: "2026-10-19", riskLevel: "AT_RISK" },
  ],
};

describe("portfolio health trend", () => {
  const r = portfolioHealthTrend(base);

  it("counts accounts per band now, citing the snapshots", () => {
    const f = fig(r, "At Risk now");
    expect(f.value).toBe(2);
    expect(f.sources).toMatchObject({ type: "HealthScoreSnapshot", ids: ["s1c", "s3c"] });
  });

  it("never counts an unscored account as healthy or at risk; says how many are unscored", () => {
    const f = fig(r, "Not scored yet");
    expect(f.value).toBe(1);
    expect(f.sources.ids).toEqual(["a4"]);
  });

  it("gives one figure per band per week using the latest snapshot on or before that day", () => {
    expect(fig(r, "Healthy on 2026-10-05").value).toBe(1);
    expect(fig(r, "At Risk on 2026-10-05").value).toBe(1);
    expect(fig(r, "Watch on 2026-10-12").value).toBe(1); // a1 only; a2 carried from 10-05 is At Risk
    expect(fig(r, "At Risk on 2026-10-12").value).toBe(1);
    expect(fig(r, "At Risk on 2026-10-19").value).toBe(2);
  });

  it("counts who got worse and who got better between the first and last day", () => {
    expect(fig(r, "Moved to a worse band").sources.ids).toEqual(["a1"]);
    expect(fig(r, "Moved to a better band").sources.ids).toEqual(["a2"]);
  });

  it("reports ARR in At Risk as money in the base currency, and says how many have no ARR", () => {
    const f = fig(r, "ARR in At Risk now");
    expect(f).toMatchObject({ unit: "money", value: "10000", currency: "USD" });
    expect(fig(r, "At Risk accounts with no ARR on file").sources.ids).toEqual(["a3"]);
  });

  it("an empty portfolio says so instead of showing zeros", () => {
    const e = portfolioHealthTrend({ ...base, accounts: [], snapshots: [] });
    const f = fig(e, "At Risk now");
    expect(f.value).toBeNull();
    expect(f.reason).toMatch(/No accounts/);
  });

  it("a band with no accounts in the period start still reads as a count; no snapshot at all is 'No health history'", () => {
    const e = portfolioHealthTrend({ ...base, snapshots: [] });
    expect(fig(e, "Healthy on 2026-10-05").value).toBeNull();
    expect(fig(e, "Healthy on 2026-10-05").reason).toMatch(/No health history/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
