"use client";

import { useActionState, useId } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { outsideSignalAction, type ActionState } from "@/modules/signals/actions/signals";
import { OUTSIDE_KIND_WORDS, OUTSIDE_KINDS } from "@/modules/signals/schemas";

/** Add public news about a customer: the source link and the event date are required (INTERP-6). */
export function OutsideSignalForm({ accounts }: { accounts: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(outsideSignalAction, {});
  const id = useId();
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      {accounts.length === 1 ? (
        <input type="hidden" name="accountId" value={accounts[0]!.id} />
      ) : (
        <div className="space-y-1">
          <label htmlFor={`${id}-account`} className="text-muted-foreground block text-xs">
            Account
          </label>
          <NativeSelect id={`${id}-account`} name="accountId" required defaultValue="">
            <option value="" disabled>
              Choose an account
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={`${id}-kind`} className="text-muted-foreground block text-xs">
          Kind
        </label>
        <NativeSelect id={`${id}-kind`} name="kind" defaultValue="LEADERSHIP_CHANGE">
          {OUTSIDE_KINDS.map((k) => (
            <option key={k} value={k}>
              {OUTSIDE_KIND_WORDS[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <label htmlFor={`${id}-headline`} className="text-muted-foreground block text-xs">
          Headline
        </label>
        <Input id={`${id}-headline`} name="headline" required minLength={3} maxLength={200} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-url`} className="text-muted-foreground block text-xs">
          Public source link
        </label>
        <Input id={`${id}-url`} name="sourceUrl" type="url" required placeholder="https://…" />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-date`} className="text-muted-foreground block text-xs">
          Date of the event
        </label>
        <Input id={`${id}-date`} name="eventDate" type="date" required />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" variant="outline" disabled={pending}>
          Add outside signal
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-2">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="text-muted-foreground text-sm sm:col-span-2">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
