"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  acceptInviteAsExistingUserAction,
  acceptInviteAsNewUserAction,
} from "@/modules/settings/actions/invitations";
import type { FormState } from "@/modules/settings/actions/shared";

export function NewUserAcceptForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    acceptInviteAsNewUserAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-1.5">
        <Label htmlFor="accept-email">Email</Label>
        <Input id="accept-email" value={email} readOnly disabled className="h-11 md:h-10" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accept-name">Your name</Label>
        <Input id="accept-name" name="name" autoComplete="name" required className="h-11 md:h-10" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accept-password">Choose a password</Label>
        <Input
          id="accept-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-11 md:h-10"
        />
        <p className="text-muted-foreground text-xs">At least 12 characters.</p>
      </div>
      <Button type="submit" size="lg" className="h-11 w-full md:h-10" disabled={pending}>
        {pending ? "Joining…" : "Join workspace"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ExistingUserAcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    acceptInviteAsExistingUserAction,
    {},
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <Button type="submit" size="lg" className="h-11 w-full md:h-10" disabled={pending}>
        Accept invitation
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
