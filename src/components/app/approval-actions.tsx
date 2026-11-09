"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  approveAction,
  editApproveAction,
  rejectAction,
  type ApprovalActionState,
} from "@/modules/approvals/actions/approvals";

function Result({ state }: { state: ApprovalActionState }) {
  if (state.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {state.error}
      </p>
    );
  if (!state.ok) return null;
  return (
    <div role="status" className="space-y-1 text-sm">
      <p>{state.ok}</p>
      {state.notSent?.length ? (
        <ul className="text-destructive list-disc pl-5" data-testid="not-sent-reasons">
          {state.notSent.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Approve, edit then approve, or reject one approval (spec §6F2). The edit form is controlled
 * (D-70): an error never puts the original text back over the person's edit.
 */
export function ApprovalActions({
  approvalId,
  draft,
}: {
  approvalId: string;
  draft: { subject: string; body: string } | null;
}) {
  const [approved, approveRun, approving] = useActionState(approveAction, {});
  const [edited, editRun, editing] = useActionState(editApproveAction, {});
  const [rejected, rejectRun, rejecting] = useActionState(rejectAction, {});
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [open, setOpen] = useState(false);
  const ids = { subject: useId(), body: useId(), note: useId() };
  const pending = approving || editing || rejecting;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <form action={approveRun}>
          <input type="hidden" name="approvalId" value={approvalId} />
          <Button type="submit" disabled={pending} variant="default" className="shadow-xs">
            Approve{draft ? " and send" : ""}
          </Button>
        </form>
        {draft ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            Edit before approving
          </Button>
        ) : null}
      </div>
      <Result state={approved} />

      {draft && open ? (
        <form
          action={editRun}
          className="bg-card border-border/80 space-y-3 rounded-lg border p-4 shadow-xs"
          aria-label="Edit the draft"
        >
          <input type="hidden" name="approvalId" value={approvalId} />
          <div className="space-y-1">
            <label htmlFor={ids.subject} className="text-sm font-medium">
              Subject
            </label>
            <Input
              id={ids.subject}
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.body} className="text-sm font-medium">
              Message
            </label>
            <Textarea
              id={ids.body}
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={10}
              maxLength={10_000}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Saving keeps the earlier version unchanged and records this one as a new version.
          </p>
          <Button type="submit" disabled={pending}>
            Save edit and approve
          </Button>
          <Result state={edited} />
        </form>
      ) : null}

      <form action={rejectRun} className="flex flex-wrap items-end gap-2.5 border-t border-border/80 pt-4">
        <input type="hidden" name="approvalId" value={approvalId} />
        <div className="space-y-1">
          <label htmlFor={ids.note} className="text-muted-foreground block text-xs">
            Why reject it?
          </label>
          <Input
            id={ids.note}
            name="note"
            required
            minLength={3}
            maxLength={1_000}
            className="h-9 w-72"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          className="hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
          disabled={pending}
        >
          Reject
        </Button>
      </form>
      <Result state={rejected} />
    </div>
  );
}
