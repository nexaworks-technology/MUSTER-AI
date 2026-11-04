import { describe, expect, it } from "vitest";
import { whitespace } from "../whitespace";

const catalog = [
  { featureKey: "dashboards", label: "Dashboards", includedInPlans: ["Growth", "Scale"] },
  { featureKey: "api", label: "API access", includedInPlans: ["Scale"] },
  { featureKey: "reports", label: "Scheduled reports", includedInPlans: ["Growth", "Scale"] },
];
const base = {
  asOf: "2026-11-02",
  plan: "Growth",
  catalog,
  featureUsage: [{ featureKey: "dashboards", lastUsed: "2026-11-01" }],
  seatsPurchased: 40,
  seatsInUse: 31,
};

describe("whitespace", () => {
  it("lists plan features not used in 30 days, and only features in the plan", () => {
    const w = whitespace(base);
    expect(w.features).toMatchObject({ state: "OK", total: 2 });
    if (w.features.state !== "OK") throw new Error("unreachable");
    expect(w.features.unused.map((f) => f.featureKey)).toEqual(["reports"]);
    expect(w.features.unused[0]).toMatchObject({ lastUsed: null, daysQuiet: null });
  });
  it("a feature last used 45 days ago is unused in the window and says how long", () => {
    const w = whitespace({
      ...base,
      featureUsage: [{ featureKey: "reports", lastUsed: "2026-09-18" }],
    });
    if (w.features.state !== "OK") throw new Error("unreachable");
    expect(w.features.unused.find((f) => f.featureKey === "reports")?.daysQuiet).toBe(45);
  });
  it("seat headroom is purchased minus in use, negative when over", () => {
    expect(whitespace(base).seats).toEqual({ state: "OK", purchased: 40, inUse: 31, headroom: 9 });
    expect(whitespace({ ...base, seatsInUse: 52 }).seats).toMatchObject({ headroom: -12 });
  });
  it("missing data says so instead of showing zero", () => {
    expect(whitespace({ ...base, featureUsage: null }).features).toMatchObject({
      state: "NO_DATA",
    });
    expect(whitespace({ ...base, plan: null }).features).toMatchObject({ state: "NO_DATA" });
    expect(whitespace({ ...base, seatsPurchased: null }).seats).toMatchObject({ state: "NO_DATA" });
    expect(whitespace({ ...base, seatsInUse: null }).seats).toMatchObject({ state: "NO_DATA" });
  });
  it("carries no money key at all", () => {
    expect(JSON.stringify(whitespace(base))).not.toMatch(/minor|price|arr|\$/i);
  });
});
