import { formatMoney } from "@/lib/money";

/** Display helpers shared by screens. Dates render in the workspace time zone. */
export function formatDate(date: Date | null | undefined, timeZone: string): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(date);
}

export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

export function formatArr(arr: { minor: bigint; currency: string } | null | undefined): string {
  return arr ? formatMoney({ minor: arr.minor, currency: arr.currency }) : "—";
}

/** Text shown where a value exists but this user may not see it (revenue:view). */
export const RESTRICTED = "Restricted";
