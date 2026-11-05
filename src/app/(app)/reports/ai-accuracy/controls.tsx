"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { killRuleAction, tuneRuleAction, type AccuracyActionState } from "./actions";

const words = (path: string) =>
  path
    .replace(/\./g, " › ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

function Message({ state }: { state: AccuracyActionState }) {
  return state.error ? (
    <p role="alert" className="text-destructive text-sm">
      {state.error}
    </p>
  ) : state.ok ? (
    <p role="status" className="text-muted-foreground text-sm">
      {state.ok}
    </p>
  ) : null;
}

/** Tune: this rule's thresholds, from the catalog's own parameters. A change bumps the rule version. */
export function TuneRuleForm({
  ruleKey,
  label,
  params,
}: {
  ruleKey: string;
  label: string;
  params: Array<[string, number]>;
}) {
  const [state, action, pending] = useActionState<AccuracyActionState, FormData>(
    tuneRuleAction,
    {},
  );
  if (params.length === 0) return null;
  return (
    <form action={action} className="space-y-2" aria-label={`Tune ${label}`}>
      <input type="hidden" name="ruleKey" value={ruleKey} />
      <div className="flex flex-wrap gap-3">
        {params.map(([path, value]) => {
          const id = `${ruleKey}-${path}`;
          return (
            <div key={path} className="space-y-1">
              <label htmlFor={id} className="text-muted-foreground block text-xs">
                {words(path)}
              </label>
              <Input
                id={id}
                name={`p.${path}`}
                type="number"
                step="any"
                defaultValue={value}
                className="h-8 w-28"
              />
            </div>
          );
        })}
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Tune {label.toLowerCase()}
      </Button>
      <Message state={state} />
    </form>
  );
}

/** Kill: switches the rule off, behind an explicit confirm step. */
export function KillRuleForm({ ruleKey, label }: { ruleKey: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState<AccuracyActionState, FormData>(
    killRuleAction,
    {},
  );
  if (!confirming)
    return (
      <div className="space-y-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Kill {label.toLowerCase()}
        </Button>
        <Message state={state} />
      </div>
    );
  return (
    <form action={action} className="space-y-2" aria-label={`Kill ${label}`}>
      <input type="hidden" name="ruleKey" value={ruleKey} />
      <input type="hidden" name="confirm" value="yes" />
      <p className="text-sm">
        Switch off <strong>{label}</strong>? It stops raising signals until someone switches it back
        on in Settings › Signals. Signals already raised stay.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={pending}>
          Yes, switch it off
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      <Message state={state} />
    </form>
  );
}
