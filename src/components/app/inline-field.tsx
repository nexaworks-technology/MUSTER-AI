"use client";

import { useActionState, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { updateAccountFieldAction, type ActionState } from "@/modules/accounts/actions/edit";
import { cn } from "@/lib/utils";

/**
 * One inline-editable account field. Restyled to read as data: borderless until hover/focus
 * with a custom chevron indicator, while preserving all form fields, actions, and semantics.
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

  const baseControl =
    "text-foreground h-7 rounded-md border border-transparent bg-transparent px-2 text-xs transition-all duration-150 outline-none hover:border-border hover:bg-card hover:shadow-2xs focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-50 cursor-pointer focus:cursor-text";

  return (
    <form ref={form} action={action} className="group/field relative inline-flex items-center gap-1.5">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="field" value={field} />
      {type === "select" ? (
        <div className="relative inline-flex items-center">
          <select
            name="value"
            defaultValue={value}
            aria-label={label}
            disabled={pending}
            className={cn(baseControl, "appearance-none pr-6 font-normal")}
            onChange={() => form.current?.requestSubmit()}
          >
            {options!.map((o) => (
              <option key={o.value} value={o.value} className="bg-popover text-popover-foreground">
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground/60 transition-opacity group-hover/field:text-foreground"
          />
        </div>
      ) : (
        <input
          type="date"
          name="value"
          defaultValue={value}
          aria-label={label}
          disabled={pending}
          className={cn(baseControl, "font-normal tabular-nums")}
          onChange={(e) => e.currentTarget.value && form.current?.requestSubmit()}
        />
      )}
      <span
        role={state.error ? "alert" : "status"}
        className={cn(
          "text-[11px] whitespace-nowrap",
          state.error ? "text-destructive font-medium" : "text-muted-foreground",
        )}
      >
        {pending ? "Saving…" : (state.error ?? (state.ok ? "Saved" : ""))}
      </span>
    </form>
  );
}
