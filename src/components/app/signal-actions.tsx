"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signalDecisionAction, type ActionState } from "@/modules/signals/actions/signals";

/** Acknowledge, or mark a false alarm with a reason (D-53: it stays quiet until materially worse). */
export function SignalActions({
  signalId,
  title,
  status,
}: {
  signalId: string;
  title: string;
  status: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(signalDecisionAction, {});
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        {status === "OPEN" ? (
          <form action={action}>
            <input type="hidden" name="signalId" value={signalId} />
            <input type="hidden" name="intent" value="acknowledge" />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-label={`Acknowledge: ${title}`}
            >
              Acknowledge
            </Button>
          </form>
        ) : null}
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="signalId" value={signalId} />
          <input type="hidden" name="intent" value="false_alarm" />
          <div className="space-y-1">
            <label htmlFor={id} className="text-muted-foreground block text-xs">
              Why is it a false alarm?
            </label>
            <Input
              id={id}
              name="reason"
              required
              minLength={3}
              maxLength={500}
              className="h-8 w-56"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending}
            aria-label={`Mark false alarm: ${title}`}
          >
            Mark false alarm
          </Button>
        </form>
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
    </div>
  );
}
