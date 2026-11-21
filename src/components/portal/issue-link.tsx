"use client";

import { useActionState } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { issuePortalLinkAction, type PortalLinkState } from "@/modules/portal/actions/links";

/** Gives one contact a portal link; the link is shown here once, to copy and send yourself. */
export function IssuePortalLink({
  accountId,
  contacts,
}: {
  accountId: string;
  contacts: Array<{ id: string; name: string; email: string | null }>;
}) {
  const [state, action, pending] = useActionState<PortalLinkState, FormData>(
    issuePortalLinkAction,
    {},
  );
  const withEmail = contacts.filter((c) => c.email);
  return (
    <div className="space-y-3">
      <form
        action={action}
        className="flex flex-wrap items-end gap-2"
        aria-label="Give portal access"
      >
        <input type="hidden" name="accountId" value={accountId} />
        <div>
          <label htmlFor="portal-contact" className="mb-1 block text-xs font-medium">
            Contact
          </label>
          <NativeSelect id="portal-contact" name="contactId" className="h-8 text-sm" required>
            {withEmail.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.email})
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" size="sm" disabled={pending || withEmail.length === 0}>
          {pending ? "Creating…" : "Create portal link"}
        </Button>
      </form>
      {withEmail.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No contact on this account has an email on file.
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.url ? (
        <div role="status" className="space-y-1 text-sm" data-testid="portal-link-issued">
          <p>
            Link for {state.contactName}, valid until{" "}
            {new Date(state.expiresAt!).toLocaleDateString()}. Copy it now: it is not shown again.
            Nothing was sent; send it to them yourself.
          </p>
          <Input
            readOnly
            value={state.url}
            aria-label="Portal link"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      ) : null}
    </div>
  );
}
