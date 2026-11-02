"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pulseAction, type ActionState } from "@/modules/health/actions/pulse";

/**
 * CSM Pulse buttons (spec §6C5): "Actually fine" / "Worried", with an optional comment. The
 * result is announced; the score beside it is re-computed, never overwritten.
 */
export function PulseControls({
  accountId,
  accountName,
  compact = false,
}: {
  accountId: string;
  accountName?: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(pulseAction, {});
  const id = `pulse-comment-${accountId}`;
  return (
    <form action={action} className={compact ? "flex flex-wrap items-center gap-1" : "space-y-2"}>
      <input type="hidden" name="accountId" value={accountId} />
      {compact ? null : (
        <div className="space-y-1">
          <label htmlFor={id} className="text-muted-foreground block text-xs">
            Comment (optional)
          </label>
          <Input
            id={id}
            name="comment"
            maxLength={500}
            className="max-w-md"
            placeholder="What makes you say so?"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          type="submit"
          name="value"
          value="FINE"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={
            compact ? `Pulse for ${accountName ?? "this account"}: actually fine` : undefined
          }
        >
          Actually fine
        </Button>
        <Button
          type="submit"
          name="value"
          value="WORRIED"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={compact ? `Pulse for ${accountName ?? "this account"}: worried` : undefined}
        >
          Worried
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="text-muted-foreground text-sm">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
