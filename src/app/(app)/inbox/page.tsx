import type { Metadata, Route } from "next";
import Link from "next/link";
import { ExtractionLabels } from "@/components/app/extraction-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { draftReplyAction } from "@/modules/inbox/actions/inbox";
import { listInbox, listUnmatched } from "@/modules/inbox/service";

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
      className={`rounded-md px-3 py-1 text-sm ${active ? "bg-accent text-accent-foreground font-medium" : "text-foreground hover:bg-hover"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-muted-foreground text-sm">
          Emails and tickets from your customers. Intent and tone are read from the words, with the
          quote shown. Nothing is sent from here without an approval.
        </p>
      </div>
      <nav aria-label="Inbox views" className="flex flex-wrap gap-1">
        {tab("/inbox", "Open", status === "OPEN")}
        {tab("/inbox?status=ALL", "All", status === "ALL")}
        {can(ctx, "accounts:edit")
          ? tab("/inbox/unmatched", `Unmatched (${unmatched})`, false)
          : null}
      </nav>
      {draftNote ? (
        <p
          role="status"
          className="bg-muted text-foreground rounded-md px-3 py-2 text-sm"
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
        <ul className="surface divide-border divide-y" data-testid="inbox-list">
          {items.map((i) => (
            <li key={i.id} className="space-y-1 p-3 text-sm" data-testid="inbox-item">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Link
                  href={`/accounts/${i.account.id}` as Route}
                  className="text-primary font-medium underline underline-offset-2"
                >
                  {i.account.name}
                </Link>
                <span className="text-muted-foreground text-xs uppercase">
                  {i.sourceType === "TICKET" ? "Ticket" : "Email"}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(i.receivedAt, tz)} · {STATUS_WORDS[i.status]} ·{" "}
                  {MATCH_WORDS[i.matchedBy]}
                </span>
              </div>
              <p className="font-medium">
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
                <span className="text-muted-foreground font-normal">from {i.from}</span>
              </p>
              <p className="text-muted-foreground">{i.snippet}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                {i.intent ? <Badge>Intent: {i.intent}</Badge> : null}
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
                    className="text-primary underline underline-offset-2"
                    data-testid="draft-link"
                  >
                    Reply drafted · see it in Approvals
                  </Link>
                ) : canDraft && i.status !== "CLOSED" ? (
                  <form action={draftReplyAction}>
                    <input type="hidden" name="inboxItemId" value={i.id} />
                    <Button type="submit" variant="outline" size="sm" data-testid="draft-reply">
                      Draft a reply
                    </Button>
                  </form>
                ) : null}
                {i.sensitive.isSensitive ? (
                  <span className="text-muted-foreground">No auto-send option, ever.</span>
                ) : null}
              </div>
              {i.relatedTickets.length > 0 ? (
                <p className="text-xs" data-testid="related-tickets">
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
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <nav aria-label="Pages" className="text-sm">
          <Link
            href={{ pathname: "/inbox", query: { status, cursor: nextCursor } }}
            className="text-primary underline underline-offset-2"
          >
            Older
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
