/**
 * Slice 7: Pure QBR metrics engine and placeholder validation.
 *
 * Rules:
 * - Period labels obey a closed allowlist: Quarter labels (e.g., "Q3 2026") or ISO dates.
 * - Raw quantities and currency strings are strictly refused as period labels.
 * - Narrative edits are text-only: raw currency or unverified metrics cannot be injected into narrative blocks.
 * - Missing metric values return null with an honest explanatory label.
 * - Revenue metrics are gated by canViewRevenue (Rule 6).
 */

const QUARTER_REGEX = /^Q[1-4]\s+\d{4}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:\s*(?:to|-)\s*\d{4}-\d{2}-\d{2})?$/;
const FORBIDDEN_PERIOD_PATTERNS = [
  /[$£€]/,
  /\bseats\b/i,
  /\bUSD\b/i,
  /\bEUR\b/i,
  /\bGBP\b/i,
  /%/,
];

export function isValidPeriodLabel(label: string): boolean {
  const trimmed = label.trim();
  for (const forbidden of FORBIDDEN_PERIOD_PATTERNS) {
    if (forbidden.test(trimmed)) return false;
  }
  return QUARTER_REGEX.test(trimmed) || ISO_DATE_REGEX.test(trimmed);
}

export function validatePeriodLabel(label: string): { valid: true; value: string } | { valid: false; error: string } {
  const trimmed = label.trim();
  if (isValidPeriodLabel(trimmed)) {
    return { valid: true, value: trimmed };
  }
  return {
    valid: false,
    error: `Period label "${label}" does not match closed allowlist pattern (e.g. "Q3 2026" or "YYYY-MM-DD"). Quantities and currency strings are forbidden.`,
  };
}

const FORBIDDEN_CURRENCY_PATTERNS = [
  /[$£€]\s*[\d,]+(?:\.\d+)?(?:\s*[kKmMbB])?/,
  /[\d,]+(?:\.\d+)?\s*(?:USD|EUR|GBP|k\s*USD)/i,
];

export function validateNarrativeText(text: string): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const pat of FORBIDDEN_CURRENCY_PATTERNS) {
    const match = text.match(pat);
    if (match) {
      violations.push(`Narrative block contains raw currency string "${match[0]}". Financial metrics must live in the locked metric panel, not in editable narrative text.`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export interface QbrMetricsAccount {
  id: string;
  name: string;
  arrMinor: bigint | null;
  arrCurrency: string | null;
}

export interface QbrHealthSnapshot {
  overall: number | null;
  riskLevel: string;
  adoption?: number | null;
  engagement?: number | null;
  support?: number | null;
  relationship?: number | null;
  commercial?: number | null;
  sentiment?: number | null;
}

export interface QbrContract {
  seatsPurchased?: number | null;
  startDate?: Date | null;
  renewalDate?: Date | null;
}

export interface QbrUsageRow {
  date: Date;
  seatsUsed: number | null;
}

export interface QbrPromise {
  status: string;
}

export interface QbrTicket {
  id: string;
}

export interface ComputeQbrMetricsInput {
  account: QbrMetricsAccount;
  healthSnapshot: QbrHealthSnapshot | null;
  contract: QbrContract | null;
  usage: QbrUsageRow[];
  promises: QbrPromise[];
  tickets: QbrTicket[];
  canViewRevenue: boolean;
}

export interface ComputedQbrMetrics {
  health: {
    score: number | null;
    band: string | null;
    riskLevel: string | null;
    label: string | null;
    pillars: Record<string, number | null>;
  };
  contract: {
    seatsPurchased: number | null;
    startDate: string | null;
    renewalDate: string | null;
    label: string | null;
  };
  usage: {
    latestSeatsUsed: number | null;
    utilizationPercent: number | null;
    label: string | null;
  };
  support: {
    ticketCount: number;
    label: string | null;
  };
  promises: {
    total: number;
    kept: number;
    late: number;
    open: number;
    broken: number;
    label: string | null;
  };
  revenue: {
    arrFormatted: string | null;
    currency: string | null;
    label: string | null;
  };
}

function bandForScore(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 80) return "GOOD";
  if (score >= 60) return "FAIR";
  return "POOR";
}

function formatArr(minor: bigint | null, currency: string | null): string | null {
  if (minor === null || currency === null) return null;
  const major = Number(minor) / 100;
  const sym = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : `${currency} `;
  return `${sym}${major.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function computeQbrMetrics(input: ComputeQbrMetricsInput): ComputedQbrMetrics {
  // 1. Health
  const healthScore = input.healthSnapshot?.overall ?? null;
  const healthBand = bandForScore(healthScore);
  const health = {
    score: healthScore,
    band: healthBand,
    riskLevel: input.healthSnapshot?.riskLevel ?? null,
    label: healthScore === null ? "No health data recorded for this account" : null,
    pillars: {
      adoption: input.healthSnapshot?.adoption ?? null,
      engagement: input.healthSnapshot?.engagement ?? null,
      support: input.healthSnapshot?.support ?? null,
      relationship: input.healthSnapshot?.relationship ?? null,
      commercial: input.healthSnapshot?.commercial ?? null,
      sentiment: input.healthSnapshot?.sentiment ?? null,
    },
  };

  // 2. Contract
  const contract = {
    seatsPurchased: input.contract?.seatsPurchased ?? null,
    startDate: input.contract?.startDate ? input.contract.startDate.toISOString().slice(0, 10) : null,
    renewalDate: input.contract?.renewalDate ? input.contract.renewalDate.toISOString().slice(0, 10) : null,
    label: !input.contract ? "No active contract found" : null,
  };

  // 3. Usage
  const sortedUsage = [...input.usage].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latestSeatsUsed = sortedUsage.at(-1)?.seatsUsed ?? null;
  const seatsPurchased = contract.seatsPurchased;
  let utilizationPercent: number | null = null;
  if (latestSeatsUsed !== null && seatsPurchased && seatsPurchased > 0) {
    utilizationPercent = Math.round((latestSeatsUsed / seatsPurchased) * 100);
  }

  const usage = {
    latestSeatsUsed,
    utilizationPercent,
    label: sortedUsage.length === 0 ? "No seat usage data logged" : null,
  };

  // 4. Support
  const support = {
    ticketCount: input.tickets.length,
    label: input.tickets.length === 0 ? "No support tickets found" : null,
  };

  // 5. Promises
  let kept = 0;
  let late = 0;
  let open = 0;
  let broken = 0;

  for (const p of input.promises) {
    if (p.status === "KEPT") kept++;
    else if (p.status === "LATE") late++;
    else if (p.status === "BROKEN") broken++;
    else open++;
  }

  const promises = {
    total: input.promises.length,
    kept,
    late,
    open,
    broken,
    label: input.promises.length === 0 ? "No promises recorded" : null,
  };

  // 6. Revenue
  let arrFormatted: string | null = null;
  let revenueLabel: string | null = null;

  if (!input.canViewRevenue) {
    revenueLabel = "Revenue access required";
  } else if (input.account.arrMinor !== null) {
    arrFormatted = formatArr(input.account.arrMinor, input.account.arrCurrency ?? "USD");
  } else {
    revenueLabel = "No ARR recorded on account";
  }

  const revenue = {
    arrFormatted,
    currency: input.canViewRevenue ? input.account.arrCurrency : null,
    label: revenueLabel,
  };

  return {
    health,
    contract,
    usage,
    support,
    promises,
    revenue,
  };
}
