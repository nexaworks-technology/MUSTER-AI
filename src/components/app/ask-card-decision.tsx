"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { decideCardAction, type AskActionState } from "@/modules/ask-ai/actions/ask";

/** Yes / No on an Ask confirmation card; rendered only when the viewer may decide (server-checked again). */
export function AskCardDecision({ approvalId }: { approvalId: string }) {
  const [state, action, pending] = useActionState<AskActionState, FormData>(decideCardAction, {});
  return (
    <div className="space-y-2">
      <form action={action} className="flex gap-2">
        <input type="hidden" name="approvalId" value={approvalId} />
        <Button
          type="submit"
          name="decision"
          value="yes"
          disabled={pending}
          className="bg-ask-accent-text text-background rounded-full hover:opacity-90"
        >
          Yes, do it
        </Button>
        <Button
          type="submit"
          name="decision"
          value="no"
          variant="outline"
          disabled={pending}
          className="border-ask-pill-line hover:bg-ask-wash rounded-full"
        >
          No
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm">
          {state.ok}
        </p>
      ) : null}
    </div>
  );
}
