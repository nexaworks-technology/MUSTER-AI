import { describe, expect, it } from "vitest";
import { renewalOutcomesReport, type RenewalOutcomesInput } from "../renewal-outcomes";
import { everyFigureIsProven, fig } from "./helpers";

type O = RenewalOutcomesInput["outcomes"][number];
const o = (id: string, p: Partial<O>): O => ({
  id,
  accountId: `acc-${id}`,
  renewalId: `ren-${id}`,
  result: "RENEWED",
  occurredOn: "2026-10-10",
  outcomeArrMinor: 100_00n,
  currency: "USD",
  forecastBand: "HIGH",
  forecastArrAtRiskMinor: 100_00n,
  supersedesId: null,
  ...p,
});

const input: RenewalOutcomesInput = {
  baseCurrency: "USD",
  query: "",
  upcomingDays: 90,
  outcomes: [
    o("o1", {}), // renewed, forecast HIGH
    o("o2", { outcomeArrMinor: 80_00n, forecastBand: "MEDIUM", forecastArrAtRiskMinor: 90_00n }),
    o("o3", {
      result: "CHURNED",
      outcomeArrMinor: 0n,
      forecastBand: "LOW",
      forecastArrAtRiskMinor: 70_00n,
    }),
    o("o4", {
      result: "CHURNED",
      outcomeArrMinor: 0n,
      forecastBand: "HIGH",
      forecastArrAtRiskMinor: 30_00n,
    }),
    o("o5", { outcomeArrMinor: null }), // renewed, no contract value on file
    o("o6", { currency: "EUR", outcomeArrMinor: 5_00n, forecastArrAtRiskMinor: 5_00n }), // other currency
    o("o7", { result: "CHURNED" }), // corrected by o8
    o("o8", { result: "RENEWED", supersedesId: "o7" }),
  ],
  upcoming: [
    {
      id: "r1",
      accountId: "u1",
      arrMinor: 200_00n,
      currency: "USD",
      band: "HIGH",
      category: "COMMIT",
    },
    { id: "r2", accountId: "u2", arrMinor: 40_00n, currency: "USD", band: "LOW", category: null },
    { id: "r3", accountId: "u3", arrMinor: null, currency: null, band: "MEDIUM", category: null },
  ],
};

describe("renewal outcomes", () => {
  const r = renewalOutcomesReport(input);

  it("uses the correction, not the row it replaced", () => {
    expect(fig(r, "Renewed").sources.ids).toEqual(["o1", "o2", "o5", "o6", "o8"]);
    expect(fig(r, "Churned").sources.ids).toEqual(["o3", "o4"]);
  });

  it("renewal rate is renewed over decided, with the records", () => {
    const f = fig(r, "Renewal rate");
    expect(f.value).toBe(71); // 5 of 7
    expect(f.sources.ids).toHaveLength(7);
  });

  it("ARR renewed sums known contract values in the base currency; unknown is listed, not zero", () => {
    expect(fig(r, "ARR renewed")).toMatchObject({ unit: "money", value: "28000", currency: "USD" });
    expect(fig(r, "Renewed with no contract value on file").sources.ids).toEqual(["o5"]);
    expect(fig(r, "Outcomes in another currency (not added up)").sources.ids).toEqual(["o6"]);
  });

  it("ARR churned is the ARR at risk frozen in the forecast made before", () => {
    expect(fig(r, "ARR churned")).toMatchObject({ value: "10000", currency: "USD" });
  });

  it("compares the frozen forecast with what happened", () => {
    expect(fig(r, "Renewed, of those forecast High").value).toBe(80); // 4 of 5
    expect(fig(r, "Churned, of those forecast Low").value).toBe(100); // 1 of 1
  });

  it("shows the forecast for upcoming renewals using the same function as the Renewals screen", () => {
    expect(fig(r, "Renewals due in the next 90 days").sources.ids).toEqual(["r1", "r2", "r3"]);
    expect(fig(r, "Forecast ARR, High confidence").value).toBe("20000");
    expect(fig(r, "Upcoming renewals with no ARR on file").sources.ids).toEqual(["r3"]);
  });

  it("no outcomes in the period says so", () => {
    const e = renewalOutcomesReport({ ...input, outcomes: [] });
    const f = fig(e, "Renewal rate");
    expect(f.value).toBeNull();
    expect(f.reason).toMatch(/No renewal outcome recorded/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});

describe("an overdue open renewal (DEMO-WALKTHROUGH FAIL 29)", () => {
  const r = renewalOutcomesReport({
    ...input,
    upcoming: [
      ...input.upcoming,
      {
        id: "late",
        accountId: "q",
        arrMinor: 50_00n,
        currency: "USD",
        band: "MEDIUM",
        category: null,
        overdue: true,
      },
    ],
  });
  it("is counted as overdue, not as due, and stays in the forecast like the Renewals screen", () => {
    expect(fig(r, "Renewals due in the next 90 days").sources.ids).toEqual(["r1", "r2", "r3"]);
    expect(fig(r, "Overdue renewals, still open after their date").sources.ids).toEqual(["late"]);
    expect(fig(r, "Forecast ARR, Medium confidence").sources.ids).toContain("late");
    everyFigureIsProven(r);
  });
});
