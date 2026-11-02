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
    "h-8 rounded-md border border-input bg-background px-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
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
