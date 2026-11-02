"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setChampionAction, type ActionState } from "@/modules/contacts/actions/people";

export function MakeChampion({
  accountId,
  contactId,
  name,
}: {
  accountId: string;
  contactId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setChampionAction, {});
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="contactId" value={contactId} />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={`Make ${name} the champion`}
      >
        Make champion
      </Button>
      {state.error ? (
        <span role="alert" className="text-destructive text-xs">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
