/**
 * Money as integer minor units + ISO 4217 currency (DECISIONS D-09). Amounts in different
 * currencies are never added or converted (QUESTIONS Q-12): no FX data, no invented numbers.
 */
export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

export class MixedCurrencyError extends Error {
  constructor(expected: string, got: string) {
    super(`Cannot combine ${got} with ${expected}; amounts are never converted between currencies`);
    this.name = "MixedCurrencyError";
  }
}

const VALID_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export function minorDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export function money(minor: bigint, currency: string): Money {
  if (!VALID_CURRENCIES.has(currency))
    throw new Error(`Unknown currency "${currency}" (use an ISO 4217 code)`);
  return { minor, currency };
}

/** Parses "1234.56" exactly — no floating point anywhere. */
export function parseMoney(amount: string, currency: string): Money {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`"${amount}" is not a valid amount`);
  const [, sign, whole, fraction = ""] = match;
  const digits = minorDigits(currency);
  if (fraction.length > digits)
    throw new Error(`${currency} amounts have at most ${digits} decimal places`);
  const minor = BigInt(`${whole}${fraction.padEnd(digits, "0")}`);
  return money(sign ? -minor : minor, currency);
}

export function formatMoney(
  value: Money,
  opts: { compact?: boolean; locale?: string } = {},
): string {
  const digits = minorDigits(value.currency);
  // Number() is only for display; all arithmetic stays in bigint.
  const major = Number(value.minor) / 10 ** digits;
  return new Intl.NumberFormat(opts.locale ?? "en-US", {
    style: "currency",
    currency: value.currency,
    ...(opts.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
  }).format(major);
}

export function sameCurrencySum(values: readonly Money[], currency: string): Money {
  let total = 0n;
  for (const v of values) {
    if (v.currency !== currency) throw new MixedCurrencyError(currency, v.currency);
    total += v.minor;
  }
  return money(total, currency);
}

export function sumByCurrency(values: readonly Money[]): Map<string, Money> {
  const totals = new Map<string, Money>();
  for (const v of values) {
    const current = totals.get(v.currency);
    totals.set(v.currency, money((current?.minor ?? 0n) + v.minor, v.currency));
  }
  return totals;
}
