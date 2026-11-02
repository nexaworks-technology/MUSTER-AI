"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ruleSettingsAction, type ActionState } from "@/modules/signals/actions/signals";

/** Thresholds for one rule (Zod-checked on save; a change bumps the rule version, audited). */
const WORDS: Record<string, string> = {
  warnRatio: "Warn at (share of normal)",
  criticalRatio: "Critical at (share of normal)",
  clearRatio: "Clears above (share of normal)",
  minNormalUsers: "Smallest normal to judge (users)",
  materialDrop: "Reopen a false alarm after a further drop of",
  activeWeeks: "Used in at least (of 8 weeks)",
  quietDays: "Quiet for (days)",
  minActiveWeekShare: "Active in at least (share of weeks)",
  infoAt: "Info at (share of seats)",
  warnAt: "Warn at (share of seats)",
  clearBelow: "Clears below (share of seats)",
  clearAbove: "Clears above (share of seats)",
  warnAtOrBelow: "Warn at or below (share of seats)",
  minContractDays: "Contract at least (days old)",
  materialPoints: "Reopen a false alarm after a change of",
  "targetDays.URGENT": "Target days: urgent",
  "targetDays.HIGH": "Target days: high",
  "targetDays.NORMAL": "Target days: normal",
  "targetDays.LOW": "Target days: low",
  criticalMultiple: "Critical after (× target)",
  criticalFailures: "Critical after (failed payments)",
  graceDays: "Grace (days past due)",
  materialDays: "Reopen a false alarm after (more days late)",
  fromDays: "From (days before renewal)",
  toDays: "To (days before renewal)",
  highTouchDays: "High-touch limit (days)",
  midTouchDays: "Mid-touch limit (days)",
  newWithinDays: "Labelled new within (days of the event)",
};
const ROLES = ["CHAMPION", "DECISION_MAKER", "EXEC_SPONSOR", "BILLING", "DAILY_USER", "OTHER"];

function leaves(o: Record<string, unknown>, prefix = ""): Array<[string, number]> {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "number"
      ? [[`${prefix}${k}`, v] as [string, number]]
      : v && typeof v === "object" && !Array.isArray(v)
        ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
        : [],
  );
}

export function RuleSettingsForm({
  ruleKey,
  label,
  enabled,
  dormantReason,
  params,
}: {
  ruleKey: string;
  label: string;
  enabled: boolean;
  dormantReason: string | null;
  params: Record<string, unknown>;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(ruleSettingsAction, {});
  const roles = Array.isArray(params.roles) ? (params.roles as string[]) : null;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="ruleKey" value={ruleKey} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          disabled={dormantReason !== null}
          className="size-4"
        />
        {dormantReason ? `Off — ${dormantReason}` : `${label} is on`}
      </label>
      {dormantReason ? null : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {leaves(params).map(([path, value]) => {
              const id = `${ruleKey}-${path}`;
              return (
                <div key={path} className="space-y-1">
                  <label htmlFor={id} className="text-muted-foreground block text-xs">
                    {WORDS[path] ?? path}
                  </label>
                  <Input
                    id={id}
                    name={`p.${path}`}
                    type="number"
                    step="any"
                    defaultValue={value}
                    className="h-8 w-32"
                  />
                </div>
              );
            })}
          </div>
          {roles ? (
            <fieldset className="space-y-1">
              <legend className="text-muted-foreground text-xs">
                Roles that count as key contacts
              </legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {ROLES.map((r) => (
                  <label key={r} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      name="p.roles"
                      value={r}
                      defaultChecked={roles.includes(r)}
                      className="size-4"
                    />
                    {r.replace("_", " ").toLowerCase()}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Save {label.toLowerCase()}
          </Button>
        </>
      )}
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="text-muted-foreground text-sm">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
