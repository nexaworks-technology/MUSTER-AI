"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  issueUsageKeyAction,
  type UsageKeyState,
} from "@/modules/integrations/actions/integrations";

/**
 * Generate or rotate the Usage API key. The new key appears here once, in this form's own
 * result, and nowhere else: not in the address bar, a cookie, a log or the page after a reload.
 */
export function UsageKeyPanel({
  last4,
  rotatedAtText,
}: {
  last4: string | null;
  rotatedAtText: string | null;
}) {
  const [state, action, pending] = useActionState<UsageKeyState, FormData>(issueUsageKeyAction, {});
  return (
    <div className="space-y-3">
      <p className="text-sm" data-testid="usage-key-status">
        {state.key
          ? `The key ending ${state.last4} is the only one that works now.`
          : last4
            ? `A key ending ${last4} is active${rotatedAtText ? ` (made ${rotatedAtText})` : ""}. It cannot be shown again.`
            : "No key yet. Generate one to start sending events."}
      </p>
      {state.key ? (
        <Alert role="status">
          <AlertDescription className="space-y-2">
            <span className="block text-sm font-medium">
              Copy this key now. It is shown once and we keep only a fingerprint of it.
            </span>
            <code className="block text-sm break-all" data-testid="usage-key-once">
              {state.key}
            </code>
          </AlertDescription>
        </Alert>
      ) : null}
      {state.error ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          {state.error}
        </p>
      ) : null}
      <form action={action}>
        <Button type="submit" variant={last4 ? "outline" : "default"} disabled={pending}>
          {last4 || state.key ? "Rotate key" : "Generate key"}
        </Button>
        {last4 || state.key ? (
          <span className="text-muted-foreground ml-3 text-sm">
            Rotating stops the current key at once.
          </span>
        ) : null}
      </form>
    </div>
  );
}
