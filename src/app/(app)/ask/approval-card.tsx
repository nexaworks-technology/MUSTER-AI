import type { Route } from "next";
import Link from "next/link";
import { AskCardDecision } from "@/components/app/ask-card-decision";
import type { AskApprovalCard } from "@/modules/ask-ai/service";

/**
 * A view onto one Approval (D-160): its reason, the exact change list or email draft, its status
 * and, once decided, what ran. Decide controls render only when the approvals service says this
 * viewer could decide it in /approvals.
 */
export function ApprovalCard({ card }: { card: AskApprovalCard }) {
  if (!card.visible)
    return (
      <p
        className="text-muted-foreground border-border bg-card rounded-lg border px-4 py-3 text-sm"
        data-testid="approval-card"
      >
        This proposal is not in your book, so I cannot show it to you.
      </p>
    );
  const status = (card.status ?? "").toLowerCase().replaceAll("_", " ");
  return (
    <section
      className="surface space-y-2 p-4 text-sm"
      data-testid="approval-card"
      data-approval={card.id}
      aria-label="Proposed change"
    >
      <p className="font-medium">{card.reason}</p>
      <p className="text-muted-foreground text-xs">
        {card.kind === "SEND_EMAIL"
          ? "Customer email"
          : (card.kind ?? "").toLowerCase().replaceAll("_", " ")}
        {card.accountName ? ` · ${card.accountName}` : ""} ·{" "}
        <span data-testid="card-status">{status}</span>
        {card.decidedBy ? ` by ${card.decidedBy}` : ""} ·{" "}
        <Link
          href={`/approvals/${card.id}` as Route}
          className="text-primary underline underline-offset-2"
        >
          Open in Approvals
        </Link>
      </p>
      {card.changes ? (
        <ol className="list-decimal space-y-1 pl-5" data-testid="card-changes">
          {card.changes.map((label, i) => (
            <li key={i}>{label}</li>
          ))}
        </ol>
      ) : null}
      {card.email ? (
        <div className="bg-muted border-border rounded-md border p-3" data-testid="card-email">
          <p>
            <span className="text-muted-foreground">To:</span> {card.email.to}
          </p>
          <p>
            <span className="text-muted-foreground">Subject:</span> {card.email.subject}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{card.email.body}</p>
          <p className="text-muted-foreground mt-2 text-xs">
            Nothing is sent until a person approves it.
          </p>
        </div>
      ) : null}
      {card.results ? (
        <ul className="space-y-1" data-testid="card-results">
          {card.results.map((r) => (
            <li key={r.index}>
              <span className={r.status === "EXECUTED" ? "" : "text-destructive font-medium"}>
                {r.status === "EXECUTED" ? "Done" : "Skipped"}
              </span>
              : {r.label}
              {r.reason ? ` (${r.reason})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {card.canDecide ? (
        <AskCardDecision approvalId={card.id} />
      ) : card.status === "PENDING" ? (
        <p className="text-muted-foreground text-xs" data-testid="card-no-controls">
          Waiting for someone who can decide this. You can follow it in Approvals.
        </p>
      ) : null}
    </section>
  );
}
