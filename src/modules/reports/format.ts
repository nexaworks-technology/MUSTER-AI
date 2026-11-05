import { formatMoney } from "@/lib/money";
import { RESTRICTED } from "@/lib/format";
import type { Figure } from "./types";

/** How a figure reads on screen: its value in its unit, "Restricted", or why there is none. */
export function figureText(f: Figure): string {
  if (f.restricted) return RESTRICTED;
  if (f.value === null) return "No data";
  switch (f.unit) {
    case "money":
      return f.currency ? formatMoney({ minor: BigInt(f.value), currency: f.currency }) : "No data";
    case "percent":
      return `${f.value}%`;
    case "days":
      return `${f.value} ${f.value === 1 ? "day" : "days"}`;
    case "hours":
      return `${f.value} ${f.value === 1 ? "hour" : "hours"}`;
    default:
      return String(f.value);
  }
}

/** The filter fields as a URL query string (only those that are set). */
export function filtersQuery(f: {
  periodDays?: number;
  start?: string;
  end?: string;
  owner?: string;
  tier?: string;
  segment?: string;
}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}
