import type { Metadata, Route } from "next";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { getTimeline } from "@/modules/timeline/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Timeline" };

const KIND_LABEL = {
  email: "Email",
  call: "Call",
  ticket: "Ticket",
  invoice: "Billing",
  usage: "Usage",
  note: "Note",
  task: "Task",
  people: "People",
  contract: "Contract",
  revenue: "ARR",
} as const;

export default async function TimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { id } = await params;
  const { cursor } = await searchParams;
  const { ctx, account } = await loadAccount(id);
  const { items, nextCursor } = await getTimeline(ctx, account.id, cursor ?? null);
  if (items.length === 0 && !cursor)
    return (
      <p className="text-muted-foreground text-sm">Nothing has happened on this account yet.</p>
    );
  return (
    <div className="space-y-3">
      <ol className="border-border space-y-0 border-l-2" aria-label="Timeline, newest first">
        {items.map((i) => (
          <li
            key={i.key}
            className="relative ml-4 py-2 text-sm"
            data-testid="timeline-item"
            data-kind={i.kind}
          >
            <span
              className="border-background bg-muted-foreground absolute top-3.5 -left-[1.4rem] size-2.5 rounded-full border-2"
              aria-hidden="true"
            />
            <div className="text-muted-foreground text-xs">
              {KIND_LABEL[i.kind]} · {formatDateTime(i.at, ctx.workspace.timezone)}
            </div>
            <div>
              {i.href ? (
                <Link href={i.href as Route} className="hover:underline">
                  {i.title}
                </Link>
              ) : (
                i.title
              )}
            </div>
            {i.detail ? <p className="text-muted-foreground">{i.detail}</p> : null}
          </li>
        ))}
      </ol>
      {nextCursor ? (
        <Link
          href={{ pathname: `/accounts/${account.id}/timeline`, query: { cursor: nextCursor } }}
          className="text-sm underline"
        >
          Older events
        </Link>
      ) : (
        <p className="text-muted-foreground text-xs">Start of the recorded history.</p>
      )}
    </div>
  );
}
