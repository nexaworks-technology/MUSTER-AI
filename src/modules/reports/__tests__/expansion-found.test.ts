import { describe, expect, it } from "vitest";
import { expansionFoundReport, type ExpansionInput } from "../expansion-found";
import { everyFigureIsProven, fig } from "./helpers";

type O = ExpansionInput["opportunities"][number];
const o = (id: string, p: Partial<O>): O => ({
  id,
  accountId: `acc-${id}`,
  status: "OPEN",
  estimateMinor: 100_00n,
  currency: "USD",
  ...p,
});
const input: ExpansionInput = {
  baseCurrency: "USD",
  query: "",
  opportunities: [
    o("e1", {}),
    o("e2", { status: "IN_PROGRESS", estimateMinor: 50_00n }),
    o("e3", { status: "WON", estimateMinor: 70_00n }),
    o("e4", { status: "LOST" }),
    o("e5", { status: "DISMISSED" }),
    o("e6", { estimateMinor: null, currency: null }),
    o("e7", { currency: "EUR", estimateMinor: 9_00n }),
  ],
};

describe("expansion found", () => {
  const r = expansionFoundReport(input);

  it("counts what was found and where each stands", () => {
    expect(fig(r, "Opportunities found").value).toBe(7);
    expect(fig(r, "Open or in progress").sources.ids).toEqual(["e1", "e2", "e6", "e7"]);
    expect(fig(r, "Won").sources.ids).toEqual(["e3"]);
    expect(fig(r, "Lost or dismissed").sources.ids).toEqual(["e4", "e5"]);
  });

  it("sums the estimate of live opportunities as money, labelled an estimate, in the base currency", () => {
    const f = fig(r, "Estimated ARR still open (estimate)");
    expect(f).toMatchObject({ unit: "money", value: "15000", currency: "USD" });
    expect(f.sources.ids).toEqual(["e1", "e2"]);
  });

  it("opportunities with no estimate and other currencies are listed apart, not counted as zero", () => {
    expect(fig(r, "Found with no estimate").sources.ids).toEqual(["e6"]);
    expect(fig(r, "Found in another currency (not added up)").sources.ids).toEqual(["e7"]);
  });

  it("won estimate is its own money figure", () => {
    expect(fig(r, "Estimated ARR won (estimate)").value).toBe("7000");
  });

  it("none found says so", () => {
    const e = expansionFoundReport({ ...input, opportunities: [] });
    expect(fig(e, "Estimated ARR still open (estimate)").value).toBeNull();
    expect(fig(e, "Estimated ARR still open (estimate)").reason).toMatch(
      /No expansion opportunity/,
    );
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
