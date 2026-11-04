import { describe, expect, it } from "vitest";
import { disagreement, forecast, type ForecastRenewal } from "../forecast";

const r = (
  id: string,
  arr: number | null,
  band: ForecastRenewal["band"],
  category: ForecastRenewal["category"] = null,
  currency: string | null = "USD",
): ForecastRenewal => ({
  id,
  arrMinor: arr === null ? null : BigInt(arr),
  currency,
  band,
  category,
});

describe("forecast", () => {
  const f = forecast(
    [
      r("a", 100_00, "HIGH", "COMMIT"),
      r("b", 50_00, "HIGH", "AT_RISK"),
      r("c", 30_00, "MEDIUM"),
      r("d", 20_00, "LOW", "OMITTED"),
      r("e", 40_00, "LOW", null, "EUR"),
      r("f", null, "MEDIUM", null, null),
    ],
    "USD",
  );
  it("sums by band and category with contributing ids", () => {
    expect(f.byBand.HIGH).toEqual({ arrMinor: 150_00n, renewalIds: ["a", "b"] });
    expect(f.byBand.MEDIUM).toEqual({ arrMinor: 30_00n, renewalIds: ["c"] });
    expect(f.byCategory.COMMIT.renewalIds).toEqual(["a"]);
    expect(f.byCategory.UNSET.renewalIds).toEqual(["c"]);
  });
  it("omits OMITTED, lists other currencies and no-ARR renewals apart, never converting", () => {
    expect(f.omittedIds).toEqual(["d"]);
    expect(f.byBand.LOW.renewalIds).toEqual([]);
    expect(f.otherCurrencies).toEqual([{ currency: "EUR", arrMinor: 40_00n, renewalIds: ["e"] }]);
    expect(f.noArrIds).toEqual(["f"]);
  });
  it("flags a human category that differs from the band", () => {
    expect(disagreement("HIGH", "AT_RISK")).toEqual({
      band: "HIGH",
      suggests: "COMMIT",
      chosen: "AT_RISK",
    });
    expect(disagreement("HIGH", "COMMIT")).toBeNull();
    expect(disagreement("LOW", null)).toBeNull();
    expect(disagreement("LOW", "OMITTED")).toBeNull();
  });
});
