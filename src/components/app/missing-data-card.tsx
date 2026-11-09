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
      className="surface rounded-xl border border-warning/40 bg-warning-soft/10 p-4 shadow-xs flex flex-wrap items-end gap-3"
      aria-label="Missing information"
      data-testid="missing-data"
    >
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="field" value={field} />
      <div className="space-y-1">
        <label htmlFor="missing-answer" className="block text-xs font-semibold text-foreground">
          {question}
        </label>
        {field === "RENEWAL_DATE" ? (
          <Input id="missing-answer" name="value" type="date" className="w-44 h-8 text-xs bg-card" />
        ) : (
          <NativeSelect id="missing-answer" name="value" defaultValue="" className="h-8 text-xs bg-card">
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>
      <Button type="submit" name="intent" value="answer" size="sm" disabled={pending} className="h-8 text-xs font-medium">
        Answer
      </Button>
      <Button
        type="submit"
        name="intent"
        value="skip"
        size="sm"
        variant="ghost"
        disabled={pending}
        className="h-8 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Skip for {snoozeDays} days
      </Button>
      {state.error ? (
        <p role="alert" className="text-destructive w-full text-xs font-medium">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
