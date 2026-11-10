import type { Route } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MeetingIndexRow, MeetingsIndex } from "@/modules/meetings/service";

function MeetingList({
  rows,
  tz,
  showAccount,
  testId,
}: {
  rows: MeetingIndexRow[];
  tz: string;
  showAccount: boolean;
  testId: string;
}) {
  return (
    <ul className="surface divide-border divide-y overflow-hidden text-sm" data-testid={testId}>
      {rows.map((m) => (
        <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 p-4">
          <div className="min-w-0">
            <div className="font-medium">{m.title}</div>
            <div className="text-muted-foreground text-xs">
              {formatDateTime(m.startsAt, tz)}
              {showAccount ? (
                <>
                  {" · "}
                  {m.accountId ? (
                    <Link
                      href={`/accounts/${m.accountId}` as Route}
                      className="hover:text-foreground underline-offset-2 hover:underline"
                    >
                      {m.accountName}
                    </Link>
                  ) : (
                    "No account matched"
                  )}
                </>
              ) : null}
            </div>
          </div>
          <div className="flex gap-1.5">
            {m.hasBrief ? <Badge variant="accent">Brief ready</Badge> : null}
            {m.hasSummary ? <Badge variant="neutral">Summary</Badge> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Meetings & QBRs (spec §5), shared by /meetings and the Account 360 tab. Every section says
 * plainly when it is empty; nothing is invented (rule 4).
 */
export function MeetingsIndexView({
  index,
  tz,
  showAccount = true,
}: {
  index: MeetingsIndex;
  tz: string;
  showAccount?: boolean;
}) {
  return (
    <div className="space-y-section" data-testid="meetings-index">
      <section aria-labelledby="mtg-upcoming" className="space-y-3">
        <h2 id="mtg-upcoming" className="text-base font-semibold">
          Upcoming meetings ({index.upcoming.length})
        </h2>
        {index.upcoming.length === 0 ? (
          <EmptyState data-testid="meetings-upcoming-empty">
            No upcoming meetings. Meetings appear here once a calendar is connected.
          </EmptyState>
        ) : (
          <MeetingList
            rows={index.upcoming}
            tz={tz}
            showAccount={showAccount}
            testId="meetings-upcoming"
          />
        )}
      </section>
      <section aria-labelledby="mtg-past" className="space-y-3">
        <h2 id="mtg-past" className="text-base font-semibold">
          Past meetings ({index.past.length})
        </h2>
        {index.past.length === 0 ? (
          <EmptyState data-testid="meetings-past-empty">No past meetings on file.</EmptyState>
        ) : (
          <MeetingList rows={index.past} tz={tz} showAccount={showAccount} testId="meetings-past" />
        )}
      </section>
      <section aria-labelledby="mtg-qbrs" className="space-y-3">
        <h2 id="mtg-qbrs" className="text-base font-semibold">
          Business reviews (QBRs) ({index.qbrs.length})
        </h2>
        {index.qbrs.length === 0 ? (
          <EmptyState data-testid="meetings-qbrs-empty">
            No QBRs have been generated yet.
          </EmptyState>
        ) : (
          <ul
            className="surface divide-border divide-y overflow-hidden text-sm"
            data-testid="meetings-qbrs"
          >
            {index.qbrs.map((q) => (
              <li key={q.id} className="flex flex-wrap items-baseline justify-between gap-2 p-4">
                <div className="min-w-0">
                  <Link
                    href={`/meetings/qbr/${q.id}` as Route}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {q.title}
                  </Link>
                  <div className="text-muted-foreground text-xs">
                    {showAccount ? `${q.accountName} · ` : ""}
                    {q.period ?? "Period not recorded"} · generated{" "}
                    {formatDateTime(q.createdAt, tz)}
                  </div>
                </div>
                <Badge variant={q.locked ? "accent" : "neutral"}>
                  {q.locked ? "Locked for customer" : "Draft"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
