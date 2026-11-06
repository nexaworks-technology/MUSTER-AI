import type { Metadata, Route } from "next";
import Link from "next/link";
import { after } from "next/server";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { recordProductEvent } from "@/lib/pilot/capture";
import { getToday, SECTIONS } from "@/modules/today/service";

export const metadata: Metadata = { title: "Today" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const hrefFor = (i: { itemType: string; refId: string; accountId: string | null }): string => {
  switch (i.itemType) {
    case "TASK":
      return i.accountId
        ? `/accounts/${i.accountId}/tasks#task-${i.refId}`
        : `/tasks#task-${i.refId}`;
    case "SIGNAL":
      return `/accounts/${i.accountId}/signals#signal-${i.refId}`;
    case "APPROVAL":
      return `/approvals/${i.refId}`;
    default:
      return `/accounts/${i.accountId}`;
  }
};

/**
 * Today (spec §5, §6F1): what needs this member today, ranked by money × urgency with the reason
 * shown on every item. Only their own accounts and work.
 */
export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  after(() => recordProductEvent(ctx, { name: "today.opened" }));
  const sp = await searchParams;
  const cursors = Object.fromEntries(
    SECTIONS.map((s) => [
      s.key,
      Math.max(0, Number(Array.isArray(sp[s.key]) ? sp[s.key]![0] : (sp[s.key] ?? 0)) || 0),
    ]),
  );
  const sections = await getToday(ctx, { cursors });
  const empty = sections.every((s) => s.total === 0);
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-muted-foreground text-sm">
          Your accounts only, ranked by account value × urgency.
          {ctx.canViewRevenue
            ? ""
            : " You don't have revenue access, so values are not shown; the order is the same."}
        </p>
      </div>
      {empty ? (
        <p
          className="text-muted-foreground rounded-md border p-6 text-sm"
          data-testid="today-empty"
        >
          Nothing needs you today.
        </p>
      ) : null}
      {sections.map((s) => (
        <section
          key={s.key}
          aria-labelledby={`today-${s.key}`}
          className="space-y-2"
          data-testid={`today-${s.key}`}
        >
          <h2 id={`today-${s.key}`} className="text-base font-semibold">
            {s.label} <span className="text-muted-foreground font-normal">({s.total})</span>
          </h2>
          {s.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {s.key === "MEETING"
                ? "No calendar connected. Meetings appear here once one is."
                : "Nothing here."}
            </p>
          ) : (
            <ol className="divide-y rounded-md border">
              {s.items.map((i) => (
                <li key={i.id} className="space-y-1 p-3 text-sm" data-testid="today-item">
                  <Link href={hrefFor(i) as Route} className="font-medium hover:underline">
                    {i.title}
                  </Link>
                  {i.accountName && i.itemType !== "RENEWAL" ? (
                    <span className="text-muted-foreground"> · {i.accountName}</span>
                  ) : null}
                  <p className="text-muted-foreground text-xs" data-testid="today-reasons">
                    {i.reasons.map((r) => r.label).join(" × ")}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {s.next !== null || s.cursor > 0 ? (
            <nav aria-label={`${s.label} pages`} className="flex gap-3 text-sm">
              {s.cursor > 0 ? (
                <Link
                  href={`/today?${s.key}=${Math.max(0, s.cursor - 25)}` as Route}
                  className="hover:underline"
                >
                  Previous
                </Link>
              ) : null}
              {s.next !== null ? (
                <Link href={`/today?${s.key}=${s.next}` as Route} className="hover:underline">
                  Next
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      ))}
    </div>
  );
}
