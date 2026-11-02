"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { revokeInvitationAction } from "@/modules/settings/actions/members";
import type { FormState } from "@/modules/settings/actions/shared";

export function RevokeButton({ invitationId, email }: { invitationId: string; email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(revokeInvitationAction, {});
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={`Revoke invitation for ${email}`}
      >
        Revoke
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
