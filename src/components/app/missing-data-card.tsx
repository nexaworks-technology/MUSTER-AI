"use client";

import { useActionState } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { missingDataAction, type ActionState } from "@/modules/accounts/actions/missing-data";

/** One missing-data question, inline and skippable. Never blocks the page. */
export function MissingDataCard({
  accountId,
  field,
  question,
  snoozeDays,
  options,
}: {
  accountId: string;
  field: "OWNER" | "RENEWAL_DATE" | "KEY_CONTACT";
  question: string;
  snoozeDays: number;
  options: Array<{ value: string; label: string }>;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(missingDataAction, {});
  if (state.ok) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {state.ok}
      </p>
    );
  }
  return (
    <form
      action={action}
      className="border-border bg-muted flex flex-wrap items-end gap-2 rounded-md border p-3"
      aria-label="Missing information"
      data-testid="missing-data"
    >
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="field" value={field} />
      <div className="space-y-1">
        <label htmlFor="missing-answer" className="block text-sm font-medium">
          {question}
        </label>
        {field === "RENEWAL_DATE" ? (
          <Input id="missing-answer" name="value" type="date" className="bg-background w-44" />
        ) : (
          <NativeSelect id="missing-answer" name="value" defaultValue="">
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
      <Button type="submit" name="intent" value="answer" size="sm" disabled={pending}>
        Answer
      </Button>
      <Button type="submit" name="intent" value="skip" size="sm" variant="ghost" disabled={pending}>
        Skip for {snoozeDays} days
      </Button>
      {state.error ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
