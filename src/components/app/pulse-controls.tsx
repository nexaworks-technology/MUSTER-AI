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
    <form action={action} className={compact ? "inline-flex items-center gap-1.5" : "space-y-3"}>
      <input type="hidden" name="accountId" value={accountId} />
      {compact ? null : (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-muted-foreground block text-xs font-medium">
            Comment (optional)
          </label>
          <Input
            id={id}
            name="comment"
            maxLength={500}
            className="max-w-md text-sm"
            placeholder="What makes you say so?"
          />
        </div>
      )}
      <div
        className={
          compact
            ? "inline-flex items-center p-0.5 rounded-lg bg-muted/60 border border-border/60 gap-0.5"
            : "inline-flex items-center p-1 rounded-lg bg-muted/50 border border-border/60 gap-1"
        }
      >
        <Button
          type="submit"
          name="value"
          value="FINE"
          size="sm"
          variant={compact ? "ghost" : "outline"}
          disabled={pending}
          aria-label={
            compact ? `Pulse for ${accountName ?? "this account"}: actually fine` : undefined
          }
          className={
            compact
              ? "h-6 px-2 text-[11px] font-medium rounded-md hover:bg-card hover:text-foreground hover:shadow-2xs active:scale-[0.98] border-0"
              : "h-8 px-3 text-xs font-medium rounded-md shadow-2xs hover:bg-card active:scale-[0.98]"
          }
        >
          Actually fine
        </Button>
        <Button
          type="submit"
          name="value"
          value="WORRIED"
          size="sm"
          variant={compact ? "ghost" : "outline"}
          disabled={pending}
          aria-label={compact ? `Pulse for ${accountName ?? "this account"}: worried` : undefined}
          className={
            compact
              ? "h-6 px-2 text-[11px] font-medium rounded-md hover:bg-card hover:text-foreground hover:shadow-2xs active:scale-[0.98] border-0"
              : "h-8 px-3 text-xs font-medium rounded-md shadow-2xs hover:bg-card active:scale-[0.98]"
          }
        >
          Worried
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive text-xs font-medium">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="text-muted-foreground text-xs">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
