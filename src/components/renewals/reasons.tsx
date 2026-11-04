import type { Route } from "next";
import Link from "next/link";
import { setForecastCategoryAction } from "@/modules/renewals/actions/renewals";
import {
  CATEGORY_WORDS,
  type Factor,
  type RenewalRow,
  type Source,
} from "@/modules/renewals/service";

export const BAND_WORDS = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" } as const;

/** Where a source record opens (Rule 1: every reason links to its records). */
function sourceHref(accountId: string, s: Source): Route | null {
  const base = `/accounts/${s.accountId ?? accountId}`;
  switch (s.sourceType) {
    case "Contract":
    case "Invoice":
    case "Subscription":
      return `${base}/billing` as Route;
    case "Contact":
    case "StakeholderRole":
      return `${base}/people` as Route;
    case "Signal":
      return `${base}/signals` as Route;
    case "HealthSnapshot":
      return `${base}/health` as Route;
    case "OnboardingPlan":
      return `${base}/onboarding` as Route;
    case "UsageDay":
      return `${base}/usage` as Route;
    default:
      return null;
  }
}

export function Reasons({ accountId, factors }: { accountId: string; factors: Factor[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {factors.map((f) => (
        <li key={f.key}>
          <span className="font-medium">{f.label}</span>{" "}
          <span className="text-muted-foreground">
            {f.points === null
              ? "(no data, adds nothing)"
              : `(${f.points > 0 ? "+" : ""}${f.points} points)`}
          </span>
          : {f.reason}
          {f.sources.map((s, i) => {
            const href = sourceHref(accountId, s);
            const label = `${s.sourceType}${s.sourceId ? ` ${s.sourceId.slice(0, 8)}` : ""}`;
            return href ? (
              <Link key={i} href={href} className="ml-2 text-xs underline">
                {label}
              </Link>
            ) : (
              <span key={i} className="text-muted-foreground ml-2 text-xs">
                {label}
              </span>
            );
          })}
        </li>
      ))}
    </ul>
  );
}

export function CategoryControl({ row, returnTo }: { row: RenewalRow; returnTo: string }) {
  return (
    <form
      action={setForecastCategoryAction.bind(null, returnTo, row.id)}
      className="flex flex-wrap items-end gap-2 text-sm"
    >
      <label className="flex flex-col gap-1">
        Forecast category
        <select
          name="category"
          defaultValue={row.category ?? ""}
          className="border-input rounded-md border px-2 py-1"
        >
          <option value="">Not set</option>
          {(Object.keys(CATEGORY_WORDS) as Array<keyof typeof CATEGORY_WORDS>).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_WORDS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Note
        <input
          name="note"
          defaultValue={row.categoryNote ?? ""}
          maxLength={500}
          className="border-input rounded-md border px-2 py-1"
        />
      </label>
      <button type="submit" className="border-input rounded-md border px-3 py-1">
        Save
      </button>
    </form>
  );
}

export function CategoryState({ row }: { row: RenewalRow }) {
  if (!row.category) return <span className="text-muted-foreground">Not set</span>;
  return (
    <span>
      {CATEGORY_WORDS[row.category]}
      <span className="text-muted-foreground block text-xs">
        set by {row.categorySetBy ?? "a member"}
        {row.categoryNote ? `: ${row.categoryNote}` : ""}
      </span>
      {row.disagreement ? (
        <span className="block text-xs font-medium" data-testid="forecast-disagreement">
          Differs from the computed band: {BAND_WORDS[row.disagreement.band]} confidence suggests{" "}
          {CATEGORY_WORDS[row.disagreement.suggests]}.
        </span>
      ) : null}
    </span>
  );
}
