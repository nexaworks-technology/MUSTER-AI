import { describe, expect, it } from "vitest";
import {
  formatMoney,
  money,
  parseMoney,
  sameCurrencySum,
  sumByCurrency,
  MixedCurrencyError,
} from "../index";

describe("money (D-09: integer minor units + ISO currency)", () => {
  it("parses decimal strings into exact minor units per currency", () => {
    expect(parseMoney("1234.56", "USD")).toEqual(money(123456n, "USD"));
    expect(parseMoney("0.1", "USD").minor + parseMoney("0.2", "USD").minor).toBe(30n);
    expect(parseMoney("1500", "JPY")).toEqual(money(1500n, "JPY"));
    expect(parseMoney("-12.5", "EUR")).toEqual(money(-1250n, "EUR"));
  });

  it("rejects more decimals than the currency has, and junk", () => {
    expect(() => parseMoney("1.234", "USD")).toThrow(/decimal places/);
    expect(() => parseMoney("12.5", "JPY")).toThrow(/decimal places/);
    expect(() => parseMoney("12,50", "USD")).toThrow(/not a valid amount/);
    expect(() => money(1n, "usd")).toThrow(/currency/);
  });

  it("formats for display", () => {
    expect(formatMoney(money(123456n, "USD"))).toBe("$1,234.56");
    expect(formatMoney(money(1500n, "JPY"))).toBe("¥1,500");
    expect(formatMoney(money(10_800_00n, "USD"), { compact: true })).toBe("$10.8K");
  });

  it("never adds different currencies (no invented FX, Q-12)", () => {
    expect(sameCurrencySum([money(100n, "USD"), money(250n, "USD")], "USD")).toEqual(
      money(350n, "USD"),
    );
    expect(() => sameCurrencySum([money(100n, "USD"), money(100n, "EUR")], "USD")).toThrow(
      MixedCurrencyError,
    );
  });

  it("groups mixed amounts by currency instead of converting", () => {
    expect(sumByCurrency([money(100n, "USD"), money(5n, "EUR"), money(1n, "USD")])).toEqual(
      new Map([
        ["USD", money(101n, "USD")],
        ["EUR", money(5n, "EUR")],
      ]),
    );
  });
});
