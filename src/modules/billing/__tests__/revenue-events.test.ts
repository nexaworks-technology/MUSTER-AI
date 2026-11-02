import { describe, expect, it } from "vitest";
import { currentContract, deriveRevenueEvents, type ContractFacts } from "../revenue";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const AS_OF = d("2026-11-02");
const contract = (
  id: string,
  start: string,
  end: string | null,
  value: number | null,
  extra: Partial<ContractFacts> = {},
): ContractFacts => ({
  id,
  startDate: d(start),
  endDate: end ? d(end) : null,
  valueMinor: value === null ? null : BigInt(value),
  currency: "USD",
  status: "ACTIVE",
  ...extra,
});
const summary = (events: ReturnType<typeof deriveRevenueEvents>) =>
  events.map((e) => [
    e.type,
    Number(e.deltaArrMinor),
    e.effectiveDate.toISOString().slice(0, 10),
    e.sourceId,
  ]);

describe("revenue events (rule-derived ARR movement)", () => {
  it("a first contract is NEW", () => {
    expect(
      summary(deriveRevenueEvents([contract("c1", "2026-01-01", "2026-12-31", 1000)], AS_OF)),
    ).toEqual([["NEW", 1000, "2026-01-01", "c1"]]);
  });

  it("a renewal at a higher value (e.g. more seats) is EXPANSION by the difference", () => {
    const events = deriveRevenueEvents(
      [
        contract("c1", "2025-01-01", "2026-01-01", 1000),
        contract("c2", "2026-01-01", "2027-01-01", 1500),
      ],
      AS_OF,
    );
    expect(summary(events)).toEqual([
      ["NEW", 1000, "2025-01-01", "c1"],
      ["EXPANSION", 500, "2026-01-01", "c2"],
    ]);
  });

  it("a renewal at a lower value is CONTRACTION; an equal one creates no event", () => {
    expect(
      summary(
        deriveRevenueEvents(
          [
            contract("c1", "2024-01-01", "2025-01-01", 1000),
            contract("c2", "2025-01-01", "2026-01-01", 1000),
            contract("c3", "2026-01-01", "2027-01-01", 600),
          ],
          AS_OF,
        ),
      ),
    ).toEqual([
      ["NEW", 1000, "2024-01-01", "c1"],
      ["CONTRACTION", -400, "2026-01-01", "c3"],
    ]);
  });

  it("a contract that ended without a renewal is CHURN at its end date", () => {
    expect(
      summary(
        deriveRevenueEvents(
          [contract("c1", "2025-06-01", "2026-06-01", 1000, { status: "ENDED" })],
          AS_OF,
        ),
      ),
    ).toEqual([
      ["NEW", 1000, "2025-06-01", "c1"],
      ["CHURN", -1000, "2026-06-01", "c1"],
    ]);
  });

  it("a passed end date on a contract still marked active is not churn (missing renewal ≠ lost, Rule 4)", () => {
    expect(
      summary(deriveRevenueEvents([contract("c1", "2025-06-01", "2026-06-01", 1000)], AS_OF)).map(
        (e) => e[0],
      ),
    ).toEqual(["NEW"]);
  });

  it("an end date in the future is not churn yet", () => {
    expect(
      summary(deriveRevenueEvents([contract("c1", "2026-01-01", "2026-12-01", 1000)], AS_OF)).map(
        (e) => e[0],
      ),
    ).toEqual(["NEW"]);
  });

  it("coming back after a gap is CHURN then REACTIVATION", () => {
    expect(
      summary(
        deriveRevenueEvents(
          [
            contract("c1", "2024-01-01", "2025-01-01", 1000, { status: "ENDED" }),
            contract("c2", "2025-06-01", "2026-06-01", 800, { status: "ENDED" }),
          ],
          AS_OF,
        ),
      ).map((e) => e[0]),
    ).toEqual(["NEW", "CHURN", "REACTIVATION", "CHURN"]);
  });

  it("a contract with no value on file creates no event (missing data never invents money)", () => {
    expect(deriveRevenueEvents([contract("c1", "2026-01-01", null, null)], AS_OF)).toEqual([]);
  });

  it("is deterministic: same input, same events (idempotent recompute)", () => {
    const input = [
      contract("c2", "2026-01-01", "2027-01-01", 1500),
      contract("c1", "2025-01-01", "2026-01-01", 1000),
    ];
    expect(deriveRevenueEvents(input, AS_OF)).toEqual(
      deriveRevenueEvents([...input].reverse(), AS_OF),
    );
  });

  it("the current contract is the latest one in force today", () => {
    const list = [
      contract("c1", "2025-01-01", "2026-01-01", 1000),
      contract("c2", "2026-01-01", "2027-01-01", 1500),
    ];
    expect(currentContract(list, AS_OF)?.id).toBe("c2");
    expect(
      currentContract([contract("c1", "2024-01-01", "2025-01-01", 1, { status: "ENDED" })], AS_OF),
    ).toBeNull();
    expect(currentContract([contract("open", "2026-01-01", null, 5)], AS_OF)?.id).toBe("open");
    // Past end date but never marked ended: still the contract on file (Rule 4).
    expect(currentContract([contract("lapsed", "2025-01-01", "2026-01-01", 5)], AS_OF)?.id).toBe(
      "lapsed",
    );
    expect(currentContract([contract("future", "2027-01-01", null, 5)], AS_OF)).toBeNull();
  });
});
