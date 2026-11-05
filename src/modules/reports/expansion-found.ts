import { count, missing, money, sumKnown, withQuery } from "./figures";
import type { Figure, ReportContent } from "./types";

/**
 * Expansion found (spec §6G6). Opportunities found in the period, read from the same
 * ExpansionOpportunity rows the Expansion screen lists. Every amount is an estimate (the screen
 * says so too); no estimate on file is listed, never added as zero; currencies are never mixed.
 */
export type ExpansionStatus = "OPEN" | "IN_PROGRESS" | "WON" | "LOST" | "DISMISSED";
export interface ExpansionInput {
  baseCurrency: string;
  query: string;
  opportunities: Array<{
    id: string;
    accountId: string;
    status: ExpansionStatus;
    estimateMinor: bigint | null;
    currency: string | null;
  }>;
}

export function expansionFoundReport(i: ExpansionInput): ReportContent {
  const row = (o: { id: string; accountId: string }) => ({ id: o.id, accountId: o.accountId });
  const live = i.opportunities.filter((o) => o.status === "OPEN" || o.status === "IN_PROGRESS");
  const won = i.opportunities.filter((o) => o.status === "WON");
  const closed = i.opportunities.filter((o) => o.status === "LOST" || o.status === "DISMISSED");
  const inBase = (o: { estimateMinor: bigint | null; currency: string | null }) =>
    o.estimateMinor !== null && o.currency === i.baseCurrency;
  const none = "No expansion opportunity found in this period.";
  const href = (status: string) => withQuery("/expansion", `status=${status}`);

  const sum = (label: string, rows: typeof live): Figure => {
    const known = rows.filter(inBase);
    if (i.opportunities.length === 0) return missing(label, "money", "ExpansionOpportunity", none);
    return money(
      label,
      sumKnown(known, (o) => o.estimateMinor),
      i.baseCurrency,
      "ExpansionOpportunity",
      known.map(row),
      "No estimate on file for these opportunities.",
    );
  };

  return {
    notes: ["Every amount here is an estimate from a rule, not a quote or a forecast of closing."],
    sections: [
      {
        title: "Found in the period",
        figures: [
          count(
            "Opportunities found",
            "ExpansionOpportunity",
            i.opportunities.map(row),
            href("ALL"),
          ),
          count("Open or in progress", "ExpansionOpportunity", live.map(row), href("OPEN")),
          count("Won", "ExpansionOpportunity", won.map(row), href("WON")),
          count("Lost or dismissed", "ExpansionOpportunity", closed.map(row), href("ALL")),
        ],
      },
      {
        title: "Estimated value",
        figures: [
          sum("Estimated ARR still open (estimate)", live),
          sum("Estimated ARR won (estimate)", won),
          count(
            "Found with no estimate",
            "ExpansionOpportunity",
            i.opportunities.filter((o) => o.estimateMinor === null).map(row),
          ),
          count(
            "Found in another currency (not added up)",
            "ExpansionOpportunity",
            i.opportunities
              .filter((o) => o.estimateMinor !== null && o.currency !== i.baseCurrency)
              .map(row),
          ),
        ],
      },
    ],
  };
}
