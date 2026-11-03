/** Small mappings shared by the CRM adapters. Deterministic; a value they cannot read is "not on file". */

/** An employee count → the band shown on accounts. */
export function employeeBand(count: string | number | null | undefined): string | undefined {
  const n = count === null || count === undefined || count === "" ? NaN : Number(count);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n <= 50) return "1-50";
  if (n <= 200) return "51-200";
  if (n <= 1000) return "201-1000";
  return "1001+";
}

/** "24000", "24000.5" or 24000.5 → minor units; anything else is "value not on file", never 0. */
export function toMinor(amount: string | number | null | undefined): number | undefined {
  if (amount === null || amount === undefined) return undefined;
  const text = typeof amount === "number" ? amount.toFixed(2) : amount;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
