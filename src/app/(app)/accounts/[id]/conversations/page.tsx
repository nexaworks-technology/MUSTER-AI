import type { Metadata } from "next";
import Link from "next/link";
import { ExtractionLabels } from "@/components/app/extraction-labels";
import { formatDateTime } from "@/lib/format";
import { conversationPageFor, listConversations } from "@/modules/conversations/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Conversations" };

export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string; message?: string }>;
}) {
  const { id } = await params;
  const { cursor, message } = await searchParams;
  const { ctx, account } = await loadAccount(id);
  // A health reason links to one message: open the page and the thread that hold it.
  const target =
    typeof message === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(message) && cursor === undefined
      ? await conversationPageFor(ctx, account.id, message)
      : null;
  const offset = target ? target.offset : /^\d{1,5}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const tz = ctx.workspace.timezone;
  const { conversations, nextCursor } = await listConversations(ctx, account.id, offset);
  if (conversations.length === 0 && offset === 0) {
    return (
      <p className="text-muted-foreground text-sm">No emails or calls recorded for this account.</p>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="divide-border border-border divide-y rounded-md border text-sm">
        {conversations.map((c) => (
          <li key={c.id} className="p-3" data-testid="conversation">
            <details open={c.id === target?.conversationId}>
              <summary className="cursor-pointer">
                <span className="text-muted-foreground text-xs uppercase">
                  {c.channel === "CALL" ? "Call" : "Email"}
                </span>{" "}
                <span className="font-medium">{c.subject ?? "(no subject)"}</span>{" "}
                <span className="text-muted-foreground">
                  · {formatDateTime(c.lastMessageAt, tz)}
                </span>
              </summary>
              <ol className="border-border mt-2 space-y-2 border-l-2 pl-3">
                {c.messages.map((m) => (
                  <li key={m.id} id={`message-${m.id}`} className="target:bg-muted scroll-mt-4">
                    <div className="text-muted-foreground text-xs">
                      {m.direction === "INBOUND" ? "From" : "Sent by"} {m.from} ·{" "}
                      {formatDateTime(m.sentAt, tz)}
                    </div>
                    <p className="whitespace-pre-wrap">{m.bodyText}</p>
                    <ExtractionLabels labels={m.labels} />
                  </li>
                ))}
                {c.transcripts.map((t) => (
                  <li key={t.id}>
                    <div className="text-muted-foreground text-xs">
                      Transcript · {formatDateTime(t.occurredAt, tz)}
                      {t.durationSec ? ` · ${Math.round(t.durationSec / 60)} min` : ""}
                    </div>
                    <ExtractionLabels labels={t.labels} />
                    <pre
                      className="max-h-96 overflow-y-auto font-sans text-sm whitespace-pre-wrap"
                      tabIndex={0}
                    >
                      {t.text}
                    </pre>
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ul>
      <nav aria-label="Pages" className="flex gap-3 text-sm">
        {offset > 0 ? (
          <Link
            href={{
              pathname: `/accounts/${account.id}/conversations`,
              query: { cursor: String(Math.max(0, offset - 20)) },
            }}
            className="underline"
          >
            Newer
          </Link>
        ) : null}
        {nextCursor !== null ? (
          <Link
            href={{
              pathname: `/accounts/${account.id}/conversations`,
              query: { cursor: String(nextCursor) },
            }}
            className="underline"
          >
            Older
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
