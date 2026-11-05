"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FormState } from "@/modules/settings/actions/shared";
import {
  saveVoiceDictationAction,
  saveWorkspaceProfileAction,
} from "@/modules/settings/actions/workspace";

/** Q-11: Admin toggle for the browser-dictation button on Ask AI. */
export function VoiceDictationForm(props: { enabled: boolean; disclosure: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveVoiceDictationAction,
    {},
  );
  return (
    <form action={action} className="grid max-w-md gap-3 border-t pt-4">
      <h2 className="text-base font-semibold">Ask AI dictation</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="voiceDictation"
          defaultChecked={props.enabled}
          data-testid="voice-dictation-toggle"
        />
        Offer dictation in the Ask AI box
      </label>
      <p className="text-muted-foreground text-xs">{props.disclosure}</p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function WorkspaceForm(props: {
  name: string;
  timezone: string;
  baseCurrency: string;
  timezones: string[];
  currencies: string[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    saveWorkspaceProfileAction,
    {},
  );
  return (
    <form action={action} className="grid max-w-md gap-4">
      <div className="space-y-1">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input id="ws-name" name="name" defaultValue={props.name} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ws-tz">Time zone</Label>
        <NativeSelect id="ws-tz" name="timezone" defaultValue={props.timezone} className="w-full">
          {props.timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">Used for nightly checks and quiet hours.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="ws-currency">Base currency</Label>
        <NativeSelect
          id="ws-currency"
          name="baseCurrency"
          defaultValue={props.baseCurrency}
          className="w-full"
        >
          {props.currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">
          Totals include only amounts in this currency. Other currencies are listed separately and
          never converted.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
