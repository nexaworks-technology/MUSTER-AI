import type { Metadata, Route } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { SignalList } from "@/components/app/signal-list";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { todayIn } from "@/lib/dates";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";
import {
  CATEGORIES,
  CATEGORY_WORDS,
  SEVERITIES,
  SEVERITY_WORDS,
  signalListQuery,
} from "@/modules/signals/schemas";
import { listSignals } from "@/modules/signals/service";

export const metadata: Metadata = { title: "Signals" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const STATUS_OPTIONS = [
  ["LIVE", "Open and acknowledged"],
  ["OPEN", "Open"],
  ["ACKNOWLEDGED", "Acknowledged"],
  ["RESOLVED", "Resolved"],
  ["FALSE_ALARM", "Marked false alarm"],
  ["ALL", "All"],
] as const;

/** Health › Signals: every signal in the viewer's book, most severe first (spec §6D). */
export default async function SignalsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = signalListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : signalListQuery.parse({});
  const [page, rules] = await Promise.all([
    listSignals(ctx, query),
    scopedDb(ctx).signalRule.findMany(),
  ]);
  const ruleMap = new Map(rules.map((r) => [r.ruleKey, r]));
  const canDecide = can(ctx, "signals:markFalseAlarm");
  const href = (cursor: number) =>
    `/health/signals?${new URLSearchParams({ ...(raw as Record<string, string>), cursor: String(cursor) })}` as Route;

  return (
    <div className="space-y-4">
      <div>
        <Link href={"/health" as Route} className="text-muted-foreground text-sm hover:underline">
          ← Health
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Signals</h1>
      </div>
      <form
        method="get"
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label="Filter signals"
      >
        <div className="space-y-1">
          <label htmlFor="status" className="text-muted-foreground block text-xs">
            Status
          </label>
          <NativeSelect id="status" name="status" defaultValue={query.status ?? "LIVE"}>
            {STATUS_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="severity" className="text-muted-foreground block text-xs">
            Severity
          </label>
          <NativeSelect id="severity" name="severity" defaultValue={query.severity ?? ""}>
            <option value="">Any severity</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_WORDS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="category" className="text-muted-foreground block text-xs">
            Category
          </label>
          <NativeSelect id="category" name="category" defaultValue={query.category ?? ""}>
            <option value="">Any category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_WORDS[c]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>
      <p className="text-muted-foreground text-sm" role="status">
        {page.total === 0
          ? "No signals."
          : `Showing ${(query.cursor ?? 0) + 1}–${(query.cursor ?? 0) + page.rows.length} of ${page.total}`}
      </p>
      <SignalList
        signals={page.rows}
        rules={ruleMap}
        showAccount
        canAct={() => canDecide !== null}
        today={todayIn(ctx.workspace.timezone)}
      />
      <nav aria-label="Pages" className="flex gap-3 text-sm">
        {page.prevCursor !== null ? (
          <Link href={href(page.prevCursor)} className="underline">
            Previous
          </Link>
        ) : null}
        {page.nextCursor !== null ? (
          <Link href={href(page.nextCursor)} className="underline">
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
