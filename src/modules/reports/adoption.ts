import { adoption, type AdoptionInput } from "@/modules/usage/service";
import { count, measure, missing, withQuery } from "./figures";
import type { Figure, ReportContent } from "./types";

/**
 * Adoption across accounts (spec §6G4). No new arithmetic about an account: each account's
 * figures come from `adoption()`, the function behind the Adoption tab, so this report cannot
 * disagree with that screen. Here we only tally its outputs across accounts.
 */
export function adoptionReport(inputs: readonly AdoptionInput[], query = ""): ReportContent {
  const results = inputs.map((i) => ({ i, a: adoption(i) }));
  const rowOf = (accountId: string, id: string) => ({ id, accountId });

  const withSeats = results.filter((r) => r.a.seats !== null);
  const seatRow = (r: (typeof results)[number]) =>
    rowOf(r.i.accountId, r.a.seats!.sources[0]!.sourceId!);
  const sumUsed = withSeats.reduce((n, r) => n + r.a.seats!.used, 0);
  const sumBought = withSeats.reduce((n, r) => n + r.a.seats!.purchased, 0);
  const noSeats = "No seat data: no account has both a contract with seats and daily usage.";
  const seatRows = withSeats.map(seatRow);

  const seatFigures: Figure[] = [
    withSeats.length
      ? measure("Seats in use", "count", sumUsed, "UsageDaily", seatRows, noSeats)
      : missing("Seats in use", "count", "UsageDaily", noSeats),
    withSeats.length
      ? measure(
          "Seats bought (accounts with usage)",
          "count",
          sumBought,
          "UsageDaily",
          seatRows,
          noSeats,
        )
      : missing("Seats bought (accounts with usage)", "count", "UsageDaily", noSeats),
    withSeats.length
      ? measure(
          "Share of bought seats in use",
          "percent",
          Math.round((sumUsed / sumBought) * 100),
          "UsageDaily",
          seatRows,
          noSeats,
        )
      : missing("Share of bought seats in use", "percent", "UsageDaily", noSeats),
    count(
      "Accounts using under half their seats",
      "UsageDaily",
      withSeats.filter((r) => r.a.seats!.status === "UNDER").map(seatRow),
      withQuery("/accounts", query),
    ),
    count(
      "Accounts using more seats than bought",
      "UsageDaily",
      withSeats.filter((r) => r.a.seats!.status === "OVER").map(seatRow),
      withQuery("/accounts", query),
    ),
  ];

  const withFeatures = results.filter((r) => r.a.features !== null);
  const featureFigures: Figure[] = [
    withFeatures.length
      ? count(
          "Accounts with a key feature never used",
          "Account",
          withFeatures
            .filter((r) => r.a.features!.keyNeverUsed.length > 0)
            .map((r) => ({ id: r.i.accountId, accountId: r.i.accountId })),
        )
      : missing(
          "Accounts with a key feature never used",
          "count",
          "Account",
          "No feature usage data for any account in scope.",
        ),
  ];

  const none = results.filter((r) => !r.a.seats && !r.a.features && !r.a.trend);
  const dataFigures: Figure[] = [
    count(
      "Accounts with no adoption data",
      "Account",
      none.map((r) => ({ id: r.i.accountId, accountId: r.i.accountId })),
    ),
  ];

  const notes: string[] = [];
  if (none.length)
    notes.push(
      `${none.length} account${none.length === 1 ? " has" : "s have"} no usage or contract data, so they are left out of every figure above rather than counted as unused.`,
    );
  if (inputs.length === 0) notes.push("No accounts in scope for this report.");

  return {
    notes,
    sections: [
      { title: "Seats", figures: seatFigures },
      { title: "Features", figures: featureFigures },
      { title: "Missing data", figures: dataFigures },
    ],
  };
}
