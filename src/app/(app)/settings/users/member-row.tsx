"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { deactivateMemberAction, updateMemberAction } from "@/modules/settings/actions/members";
import type { FormState } from "@/modules/settings/actions/shared";
import { BOOK_SCOPE_LABELS, ROLE_LABELS } from "@/modules/settings/schemas";

export interface MemberRowData {
  membershipId: string;
  name: string;
  email: string;
  role: keyof typeof ROLE_LABELS;
  bookScope: keyof typeof BOOK_SCOPE_LABELS;
  canViewRevenue: boolean;
  active: boolean;
  isYou: boolean;
}

export function MemberRow({ member }: { member: MemberRowData }) {
  const [saveState, save, saving] = useActionState<FormState, FormData>(updateMemberAction, {});
  const [deactivateState, deactivate, deactivating] = useActionState<FormState, FormData>(
    deactivateMemberAction,
    {},
  );
  const id = member.membershipId;
  return (
    <li className="border-border space-y-2 border-b py-3" data-testid={`member-${member.email}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{member.name}</span>
          {member.isYou ? <span className="text-muted-foreground"> (you)</span> : null}
          <div className="text-muted-foreground text-sm">{member.email}</div>
        </div>
        <div className="text-muted-foreground flex gap-2 text-xs">
          {member.canViewRevenue ? (
            <span className="rounded border px-1.5 py-0.5" data-testid="revenue-badge">
              Revenue access
            </span>
          ) : null}
          {member.active ? null : <span className="rounded border px-1.5 py-0.5">Deactivated</span>}
        </div>
      </div>
      {member.active ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={save} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="membershipId" value={id} />
            <label className="sr-only" htmlFor={`role-${id}`}>
              Role for {member.email}
            </label>
            <NativeSelect id={`role-${id}`} name="role" defaultValue={member.role}>
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
            <label className="sr-only" htmlFor={`scope-${id}`}>
              Accounts {member.email} sees
            </label>
            <NativeSelect id={`scope-${id}`} name="bookScope" defaultValue={member.bookScope}>
              {Object.entries(BOOK_SCOPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name="canViewRevenue"
                defaultChecked={member.canViewRevenue}
                className="size-4"
              />
              Revenue access
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={saving}>
              Save
            </Button>
          </form>
          <form action={deactivate}>
            <input type="hidden" name="membershipId" value={id} />
            <Button type="submit" size="sm" variant="ghost" disabled={deactivating}>
              Deactivate
            </Button>
          </form>
        </div>
      ) : null}
      <FormMessage state={saveState.error || saveState.ok ? saveState : deactivateState} />
    </li>
  );
}
