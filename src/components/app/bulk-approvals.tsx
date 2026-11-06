"use client";

import type { Route } from "next";
import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { Input } from "@/components/ui/input";
import { bulkAction, type ApprovalActionState } from "@/modules/approvals/actions/approvals";

export interface BulkRow {
  id: string;
  accountName: string;
  reason: string;
  subject: string | null;
  levelLabel: string;
  sensitive: string | null;
  assignee: string | null;
  waiting: string;
}

/**
 * The pending queue with bulk decide (M4 §2): the confirmation step lists exactly the selected
 * items, and only that list is submitted. Sensitive items cannot be selected for bulk approval.
 */
export function BulkApprovals({ rows, canDecide }: { rows: BulkRow[]; canDecide: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const [state, run, pending] = useActionState<ApprovalActionState, FormData>(bulkAction, {});
  const noteId = useId();
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const chosen = rows.filter((r) => selected.includes(r.id));
  const anySensitive = chosen.some((r) => r.sensitive);

  if (rows.length === 0)
    return (
      <EmptyState className="py-6" data-testid="approvals-empty">
        Nothing is waiting for approval.
      </EmptyState>
    );

  return (
    <div className="space-y-3">
      <ul
        className="surface divide-border divide-y overflow-hidden"
        aria-label="Waiting for approval"
      >
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-start gap-3 p-4"
            data-testid="approval-row"
          >
            {canDecide ? (
              <input
                type="checkbox"
                className="border-input accent-primary mt-1 size-4"
                aria-label={`Select: ${r.accountName}, ${r.reason}`}
                checked={selected.includes(r.id)}
                onChange={() => toggle(r.id)}
              />
            ) : null}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">
                <Link href={`/approvals/${r.id}` as Route} className="hover:underline">
                  {r.accountName}: {r.reason}
                </Link>
              </p>
              {r.subject ? (
                <p className="text-muted-foreground text-sm">Email: “{r.subject}”</p>
              ) : null}
              <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span>{r.levelLabel}</span>
                {r.sensitive ? (
                  <Badge variant="danger" data-testid="sensitive-badge">
                    {r.sensitive} · Always human
                  </Badge>
                ) : null}
                <span>{r.assignee ? `Assigned to ${r.assignee}` : "Unassigned"}</span>
                <span>Waiting {r.waiting}</span>
              </p>
            </div>
          </li>
        ))}
      </ul>

      {canDecide && selected.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming("approve")}
            disabled={anySensitive}
          >
            Approve selected ({selected.length})
          </Button>
          <Button type="button" variant="outline" onClick={() => setConfirming("reject")}>
            Reject selected ({selected.length})
          </Button>
          {anySensitive ? (
            <p className="text-muted-foreground text-sm">
              Sensitive items are reviewed one at a time, so they can’t be approved in bulk.
            </p>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <form
          action={run}
          className="bg-card border-border space-y-3 rounded-lg border p-4"
          aria-label="Confirm bulk decision"
        >
          <input type="hidden" name="decision" value={confirming} />
          <p className="text-sm font-medium">
            {confirming === "approve" ? "Approve" : "Reject"} exactly these {chosen.length}:
          </p>
          <ul className="list-disc pl-5 text-sm" data-testid="bulk-confirm-list">
            {chosen.map((r) => (
              <li key={r.id}>
                {r.accountName}: {r.reason}
                <input type="hidden" name="approvalId" value={r.id} />
                <input type="hidden" name="confirmedId" value={r.id} />
              </li>
            ))}
          </ul>
          {confirming === "reject" ? (
            <div className="space-y-1">
              <label htmlFor={noteId} className="text-muted-foreground block text-xs">
                Why reject them?
              </label>
              <Input
                id={noteId}
                name="note"
                required
                minLength={3}
                maxLength={1_000}
                className="h-9 w-72"
              />
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              Confirm
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="text-sm">
          {state.ok}
          {state.notSent?.length ? ` Not sent: ${state.notSent.join("; ")}` : ""}
        </p>
      ) : null}
    </div>
  );
}
