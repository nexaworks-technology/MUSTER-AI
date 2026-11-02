"use client";

import { useActionState, type ReactNode } from "react";

/**
 * A form bound to a Server Action that returns { ok?, error? }, with the result announced to
 * screen readers. React resets uncontrolled fields after the action completes.
 */
export interface ActionState {
  ok?: string;
  error?: string;
}

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: (pending: boolean) => ReactNode;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form action={run} className={className}>
      {children(pending)}
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
