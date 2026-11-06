"use client";

import { useActionState, useRef } from "react";
import { updateAccountFieldAction, type ActionState } from "@/modules/accounts/actions/edit";
import { cn } from "@/lib/utils";

/**
 * One inline-editable account field. Saving on change keeps the page where it is (no change of
 * context); the result is announced next to the field.
 */
export function InlineField({
  accountId,
  field,
  label,
  value,
  options,
  type = "select",
}: {
  accountId: string;
  field: "ownerMembershipId" | "tier" | "lifecycleStage" | "renewalDate";
  label: string;
  value: string;
  options?: Array<{ value: string; label: string }>;
  type?: "select" | "date";
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateAccountFieldAction,
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  const control =
    "border-input bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/30 h-8 rounded-md border px-1.5 text-sm shadow-xs outline-none focus-visible:ring-3 disabled:opacity-50";
  return (
    <form ref={form} action={action} className="flex items-center gap-1">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="field" value={field} />
      {type === "select" ? (
        <select
          name="value"
          defaultValue={value}
          aria-label={label}
          disabled={pending}
          className={control}
          onChange={() => form.current?.requestSubmit()}
        >
          {options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="date"
          name="value"
          defaultValue={value}
          aria-label={label}
          disabled={pending}
          className={control}
          onChange={(e) => e.currentTarget.value && form.current?.requestSubmit()}
        />
      )}
      <span
        role={state.error ? "alert" : "status"}
        className={cn("text-xs", state.error ? "text-destructive" : "text-muted-foreground")}
      >
        {pending ? "Saving…" : (state.error ?? (state.ok ? "Saved" : ""))}
      </span>
    </form>
  );
}
