import type { Metadata, Route } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateTime } from "@/lib/format";
import { listTickets } from "@/modules/support/service";
import { sourceLabel } from "@/modules/integrations/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Tickets" };

const PRIORITY = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" } as const;
const STATUS = { OPEN: "Open", PENDING: "Pending", SOLVED: "Solved", CLOSED: "Closed" } as const;

export default async function TicketsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const tz = ctx.workspace.timezone;
  const tickets = await listTickets(ctx, account.id);
  if (tickets.length === 0)
    return <EmptyState>No support tickets recorded for this account.</EmptyState>;
  const open = tickets.filter((t) => t.isOpen).length;
  return (
    <div className="space-y-section">
      <p className="text-muted-foreground text-sm">
        {open} open · {tickets.length - open} closed
        {tickets.length === 100 ? " (latest 100 shown)" : ""}
      </p>
      <ul className="surface divide-border divide-y overflow-hidden text-sm">
        {tickets.map((t) => (
          <li
            key={t.id}
            id={`ticket-${t.id}`}
            className="target:bg-muted scroll-mt-4 p-4"
            data-testid="ticket"
          >
            <details>
              <summary className="cursor-pointer">
                <span className="font-medium">{t.subject}</span>{" "}
                <span className="text-muted-foreground">
                  · {STATUS[t.status]} · {PRIORITY[t.priority]} priority
                  {t.isEscalated ? " · escalated" : ""} · opened {formatDate(t.openedAt, tz)}
                  {t.isOpen ? ` · open ${t.ageDays} day${t.ageDays === 1 ? "" : "s"}` : ""}
                  {t.contactName ? ` · from ${t.contactName}` : ""}
                  {sourceLabel(t.source) ? ` · ${sourceLabel(t.source)}` : ""}
                </span>
                {t.isOpen && (t.priority === "HIGH" || t.priority === "URGENT" || t.isEscalated) ? (
                  <Badge variant="danger" className="ml-2">
                    Needs attention
                  </Badge>
                ) : null}
              </summary>
              <ol className="border-border mt-2 space-y-2 border-l-2 pl-3">
                {t.messages.map((m) => (
                  <li key={m.id}>
                    <div className="text-muted-foreground text-xs">
                      {m.direction === "INBOUND" ? "Customer" : "Support"} ·{" "}
                      {formatDateTime(m.sentAt, tz)}
                    </div>
                    <p className="whitespace-pre-wrap">{m.bodyText}</p>
                  </li>
                ))}
              </ol>
              {t.isOpen ? (
                <p className="mt-2 text-xs">
                  <Link
                    href={`/approvals/new?sourceType=Ticket&sourceId=${t.id}` as Route}
                    className="text-primary underline underline-offset-2"
                    data-testid="draft-check-in"
                  >
                    Draft check-in
                  </Link>
                </p>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
