"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteMemberAction } from "@/modules/settings/actions/members";
import type { FormState } from "@/modules/settings/actions/shared";
import { BOOK_SCOPE_LABELS, ROLE_LABELS } from "@/modules/settings/schemas";

export function InviteForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(inviteMemberAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <div className="space-y-1">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="invite-role">Role</Label>
        <NativeSelect id="invite-role" name="role" defaultValue="CSM" className="w-full">
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="invite-scope">Accounts they see</Label>
        <NativeSelect id="invite-scope" name="bookScope" defaultValue="OWN" className="w-full">
          {Object.entries(BOOK_SCOPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-3">
        <input type="checkbox" name="canViewRevenue" className="accent-primary size-4" />
        Revenue access (ARR, contract values, forecasts)
      </label>
      <div className="flex items-center gap-3 sm:col-span-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invitation"}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
