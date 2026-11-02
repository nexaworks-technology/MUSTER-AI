"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { recomputeAction, type ActionState } from "@/modules/signals/actions/signals";

/** Recompute now: enqueues the same chunk job the nightly run uses (M3 rule 9). */
export function RecomputeButton({
  accountId,
  label = "Recompute now",
}: {
  accountId?: string;
  label?: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recomputeAction, {});
  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      {accountId ? <input type="hidden" name="accountId" value={accountId} /> : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {label}
      </Button>
      {state.error ? (
        <span role="alert" className="text-destructive text-sm">
          {state.error}
        </span>
      ) : state.ok ? (
        <span role="status" className="text-muted-foreground text-sm">
          {state.ok}
        </span>
      ) : null}
    </form>
  );
}
