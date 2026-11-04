import { describe, expect, it } from "vitest";
import { deriveRevenueEvents, type ContractFacts } from "@/modules/billing/service";
import { arrMismatches, waterfall, type EventType, type WaterfallEvent } from "../waterfall";

const ev = (
  id: string,
  type: EventType,
  delta: number,
  date: string,
  currency = "USD",
  accountId = "a1",
): WaterfallEvent => ({
  id,
  accountId,
  type,
  deltaArrMinor: BigInt(delta),
  currency,
  effectiveDate: date,
});

describe("waterfall", () => {
  const events = [
    ev("e1", "NEW", 100_000_00, "2026-01-10"),
    ev("e2", "EXPANSION", 20_000_00, "2026-02-01"),
    // period 2026-04-01 .. 2026-06-30
    ev("e3", "NEW", 50_000_00, "2026-04-01"),
    ev("e4", "EXPANSION", 10_000_01, "2026-05-15"),
    ev("e5", "CONTRACTION", -5_000_00, "2026-05-20"),
    ev("e6", "CHURN", -20_000_00, "2026-06-30"),
    ev("e7", "REACTIVATION", 7_000_00, "2026-06-30"),
    ev("e8", "NEW", 999_00, "2026-07-01"), // after the period
    ev("x1", "NEW", 40_000_00, "2026-04-10", "EUR", "a2"),
  ];
  const w = waterfall(events, { from: "2026-04-01", to: "2026-06-30" }, "USD");

  it("opening is the sum of events before the period; movements are bucketed by type", () => {
    expect(w.base.openingMinor).toBe(120_000_00n);
    expect(w.base.new.amountMinor).toBe(50_000_00n);
    expect(w.base.expansion.amountMinor).toBe(10_000_01n);
    expect(w.base.contraction.amountMinor).toBe(-5_000_00n);
    expect(w.base.churn.amountMinor).toBe(-20_000_00n);
    expect(w.base.reactivation.amountMinor).toBe(7_000_00n);
  });
  it("reconciles to the minor unit, with the event ids behind each movement", () => {
    expect(w.base.closingMinor).toBe(
      120_000_00n + 50_000_00n + 10_000_01n - 5_000_00n - 20_000_00n + 7_000_00n,
    );
    expect(w.base.closingMinor).toBe(162_000_01n);
    expect(w.base.reconciled).toBe(true);
    expect(w.base.expansion.eventIds).toEqual(["e4"]);
    expect(w.base.anomalies).toEqual([]);
  });
  it("lists another currency on its own and never converts it", () => {
    expect(w.otherCurrencies.map((c) => c.currency)).toEqual(["EUR"]);
    expect(w.otherCurrencies[0]!.closingMinor).toBe(40_000_00n);
    expect(w.base.new.eventIds).toEqual(["e3"]);
  });
  it("a period with no events has zero opening and closing, not an error", () => {
    const z = waterfall([], { from: "2026-01-01", to: "2026-03-31" }, "USD");
    expect(z.base.closingMinor).toBe(0n);
    expect(z.base.reconciled).toBe(true);
  });
  it("shows an event whose sign contradicts its type", () => {
    const bad = waterfall(
      [ev("b1", "EXPANSION", -1, "2026-02-01")],
      { from: "2026-01-01", to: "2026-03-31" },
      "USD",
    );
    expect(bad.base.anomalies).toEqual(["b1"]);
  });
});

describe("arrMismatches (events against contracts)", () => {
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const c = (
    id: string,
    start: string,
    value: number | null,
    status: ContractFacts["status"] = "ACTIVE",
    end: string | null = null,
    currency = "USD",
  ) => ({
    id,
    accountId: "a1",
    startDate: day(start),
    endDate: end ? day(end) : null,
    valueMinor: value === null ? null : BigInt(value),
    currency,
    status,
  });

  it("derived events always agree with the contracts they came from", () => {
    const contracts = [
      c("c1", "2025-01-01", 100_00, "ENDED", "2026-01-01"),
      c("c2", "2026-01-01", 130_00),
    ];
    const derived = deriveRevenueEvents(contracts, day("2026-11-01")).map((d, i) =>
      ev(`d${i}`, d.type, Number(d.deltaArrMinor), d.effectiveDate.toISOString().slice(0, 10)),
    );
    expect(arrMismatches(derived, contracts, "2026-11-01")).toEqual([]);
  });
  it("flags a stale event total against the contract in force", () => {
    const m = arrMismatches(
      [ev("e1", "NEW", 100_00, "2025-01-01")],
      [c("c1", "2025-01-01", 120_00)],
      "2026-11-01",
    );
    expect(m).toEqual([
      {
        accountId: "a1",
        currency: "USD",
        eventsMinor: 100_00n,
        contractMinor: 120_00n,
        eventIds: ["e1"],
        contractId: "c1",
      },
    ]);
  });
  it("skips a current contract with no value (nothing to compare), and flags revenue left after a currency change", () => {
    expect(
      arrMismatches(
        [ev("e1", "NEW", 100_00, "2025-01-01")],
        [c("c1", "2025-01-01", null)],
        "2026-11-01",
      ),
    ).toEqual([]);
    const m = arrMismatches(
      [ev("e1", "NEW", 100_00, "2025-01-01")],
      [c("c1", "2025-01-01", 90_00, "ACTIVE", null, "EUR")],
      "2026-11-01",
    );
    expect(m.map((x) => [x.currency, x.eventsMinor, x.contractMinor])).toEqual([
      ["EUR", 0n, 90_00n],
      ["USD", 100_00n, 0n],
    ]);
  });
});
