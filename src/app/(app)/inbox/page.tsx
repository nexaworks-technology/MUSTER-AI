import type { Metadata, Route } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ExtractionLabels } from "@/components/app/extraction-labels";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { draftReplyAction } from "@/modules/inbox/actions/inbox";
import { listInbox, listUnmatched } from "@/modules/inbox/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Inbox" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS_WORDS = {
  NEW: "New",
  DRAFTED: "Reply drafted",
  REPLIED: "Replied",
  CLOSED: "Closed",
} as const;
const MATCH_WORDS = {
  SOURCE: "Already on the account",
  CONTACT_EMAIL: "Matched by the sender's email",
  DOMAIN: "Matched by the sender's domain",
  MANUAL: "Placed by a person",
} as const;

/** Inbox (spec §5): inbound emails and tickets on known accounts, with what the Watcher read from each. */
export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const sp = await searchParams;
  const status = first(sp.status) === "ALL" ? "ALL" : "OPEN";
  const cursor = first(sp.cursor);
  const { items, nextCursor } = await listInbox(ctx, { status, ...(cursor ? { cursor } : {}) });
  const unmatched = can(ctx, "accounts:edit") ? (await listUnmatched(ctx)).length : 0;
  const tz = ctx.workspace.timezone;
  const canDraft = Boolean(can(ctx, "approvals:decide"));
  const draftNote = {
    drafted: "Reply drafted. It is waiting in Approvals; nothing has been sent.",
    not_configured: "AI is not switched on for this workspace, so no draft was made.",
    failed: "The draft could not be made. Nothing was changed.",
    forbidden: "You can't draft replies.",
  }[first(sp.draft) ?? ""];
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href as Route}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3.5 py-1.5 text-xs sm:text-sm font-medium transition-all",
        active
          ? "bg-background text-foreground shadow-xs border border-border/80"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-section">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground text-sm">
          Emails and tickets from your customers. Intent and tone are read from the words, with the
          quote shown. Nothing is sent from here without an approval.
        </p>
      </div>
      <nav aria-label="Inbox views" className="inline-flex rounded-lg bg-muted/60 p-1 border border-border/60">
        {tab("/inbox", "Open", status === "OPEN")}
        {tab("/inbox?status=ALL", "All", status === "ALL")}
        {can(ctx, "accounts:edit")
          ? tab("/inbox/unmatched", `Unmatched (${unmatched})`, false)
          : null}
      </nav>
      {draftNote ? (
        <p
          role="status"
          className="bg-muted text-foreground rounded-md px-3.5 py-2.5 text-sm border border-border/60"
          data-testid="draft-note"
        >
          {draftNote}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="inbox-empty">
          {status === "OPEN"
            ? "Nothing waiting. Every inbound message has been answered or closed."
            : "No inbound emails or tickets in the last 30 days."}
        </p>
      ) : (
        <DataListCard>
          <ul className="divide-border divide-y" data-testid="inbox-list">
            {items.map((i) => (
              <li key={i.id} className="group p-4 text-sm hover:bg-muted/40 transition-colors space-y-2" data-testid="inbox-item">
                <div className="flex items-start gap-3.5">
                  <DataListAvatar name={i.account.name} size="sm" className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/accounts/${i.account.id}` as Route}
                          className="text-primary font-medium underline underline-offset-2 hover:text-primary/80"
                        >
                          {i.account.name}
                        </Link>
                        <StatusPill variant="neutral" size="sm" withDot={false}>
                          {i.sourceType === "TICKET" ? "Ticket" : "Email"}
                        </StatusPill>
                        <StatusPill variant={i.status === "NEW" ? "accent" : i.status === "DRAFTED" ? "warning" : "success"} size="sm">
                          {STATUS_WORDS[i.status]}
                        </StatusPill>
                      </div>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatDateTime(i.receivedAt, tz)} · {MATCH_WORDS[i.matchedBy]}
                      </span>
                    </div>
                    <p className="font-medium text-foreground">
                      <Link
                        href={
                          (i.sourceType === "MESSAGE"
                            ? `/accounts/${i.account.id}/conversations?message=${i.sourceId}`
                            : `/accounts/${i.account.id}/tickets`) as Route
                        }
                        className="hover:underline"
                      >
                        {i.title}
                      </Link>{" "}
                      <span className="text-muted-foreground font-normal text-xs">from {i.from}</span>
                    </p>
                    <p className="text-muted-foreground text-xs leading-relaxed">{i.snippet}</p>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      {i.intent ? <Badge variant="neutral">Intent: {i.intent}</Badge> : null}
                      {i.sensitive.isSensitive ? (
                        <Badge variant="danger" className="whitespace-normal" data-testid="sensitive">
                          Sensitive ({i.sensitive.reasons.join(", ")}) · Always goes to a human
                        </Badge>
                      ) : null}
                    </div>
                    <ExtractionLabels
                      labels={[
                        ...(i.sentiment
                          ? [
                              {
                                kind: "SENTIMENT" as const,
                                text: `Sentiment: ${i.sentiment.label.toLowerCase()}`,
                                tone: (i.sentiment.label === "NEGATIVE"
                                  ? "negative"
                                  : i.sentiment.label === "POSITIVE"
                                    ? "good"
                                    : i.sentiment.label === "MIXED"
                                      ? "mixed"
                                      : "neutral") as "negative" | "good" | "mixed" | "neutral",
                                quote: i.sentiment.quote,
                              },
                            ]
                          : []),
                        ...i.labels,
                      ]}
                    />
                    <div className="flex items-center gap-3 pt-1 text-xs">
                      {i.hasDraft ? (
                        <Link
                          href={"/approvals" as Route}
                          className="text-primary underline underline-offset-2 font-medium"
                          data-testid="draft-link"
                        >
                          Reply drafted · see it in Approvals
                        </Link>
                      ) : canDraft && i.status !== "CLOSED" ? (
                        <form action={draftReplyAction}>
                          <input type="hidden" name="inboxItemId" value={i.id} />
                          <Button type="submit" variant="outline" size="sm" className="h-7 text-xs" data-testid="draft-reply">
                            Draft a reply
                          </Button>
                        </form>
                      ) : null}
                      {i.sensitive.isSensitive ? (
                        <span className="text-muted-foreground text-xs">No auto-send option, ever.</span>
                      ) : null}
                    </div>
                    {i.relatedTickets.length > 0 ? (
                      <p className="text-xs text-muted-foreground pt-1" data-testid="related-tickets">
                        Same problem in {i.relatedTickets.length} other ticket
                        {i.relatedTickets.length === 1 ? "" : "s"}:{" "}
                        {i.relatedTickets.map((t, n) => (
                          <span key={t.id}>
                            {n > 0 ? ", " : ""}
                            <Link
                              href={`/accounts/${i.account.id}/tickets` as Route}
                              className="text-primary underline underline-offset-2"
                            >
                              {t.subject}
                            </Link>
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </DataListCard>
      )}
      {nextCursor ? (
        <nav aria-label="Pages" className="text-sm">
          <Link
            href={{ pathname: "/inbox", query: { status, cursor: nextCursor } }}
            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium text-xs sm:text-sm"
          >
            Older
            <ArrowRight className="size-3.5" />
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
