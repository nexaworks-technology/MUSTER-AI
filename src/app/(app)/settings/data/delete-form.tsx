"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cancelDeletionAction,
  requestDeletionAction,
} from "@/modules/settings/actions/data-delete";
import type { FormState } from "@/modules/settings/actions/shared";

export function DeleteWorkspaceForm({ workspaceName }: { workspaceName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestDeletionAction, {});
  return (
    <form action={action} className="space-y-2">
      <label className="block text-sm">
        Type <strong>{workspaceName}</strong> to confirm
        <Input
          name="confirmName"
          autoComplete="off"
          required
          className="mt-1 block max-w-sm"
          data-testid="confirm-workspace-name"
        />
      </label>
      <Button type="submit" variant="destructive" disabled={pending} data-testid="delete-workspace">
        {pending ? "Scheduling…" : "Delete this workspace"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CancelDeletionForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(cancelDeletionAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="outline" disabled={pending} data-testid="cancel-deletion">
        {pending ? "Cancelling…" : "Cancel deletion"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
