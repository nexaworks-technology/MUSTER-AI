"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  activateModelAction,
  modelEditAction,
  runBacktestAction,
  type ModelActionState,
} from "@/modules/health/actions/model";

function Result({ state }: { state: ModelActionState }) {
  if (state.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {state.ok}
      </p>
    );
  return null;
}

export function RunBacktestButton({ running }: { running: boolean }) {
  const [state, action, pending] = useActionState<ModelActionState>(runBacktestAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="outline" disabled={pending || running}>
        {running ? "Back-test running…" : "Run back-test and propose a model"}
      </Button>
      <Result state={state} />
    </form>
  );
}

export function ActivateModelButton({ modelId, version }: { modelId: string; version: number }) {
  const [state, action, pending] = useActionState<ModelActionState, FormData>(
    activateModelAction,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="modelId" value={modelId} />
      <Button type="submit" size="sm" disabled={pending}>
        Approve and activate v{version}
      </Button>
      <Result state={state} />
    </form>
  );
}

const LABELS = {
  ADOPTION: "Adoption",
  ENGAGEMENT: "Engagement",
  SUPPORT: "Support",
  RELATIONSHIP: "Relationship",
  COMMERCIAL: "Commercial",
  SENTIMENT: "Sentiment",
} as const;

/** Edit weights (percentages) and thresholds; preview the back-test before saving a new version. */
export function ModelEditForm({
  basedOnId,
  basedOnVersion,
  weights,
  thresholds,
}: {
  basedOnId: string;
  basedOnVersion: number;
  weights: Record<keyof typeof LABELS, number>;
  thresholds: { healthyMin: number; watchMin: number };
}) {
  const [state, action, pending] = useActionState<ModelActionState, FormData>(modelEditAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="basedOnId" value={basedOnId} />
      <p className="text-muted-foreground text-sm">
        Starting from v{basedOnVersion}. Weights are percentages and must add up to 100.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((p) => (
          <div key={p} className="space-y-1">
            <label htmlFor={`w-${p}`} className="text-muted-foreground block text-xs">
              {LABELS[p]} (%)
            </label>
            <Input
              id={`w-${p}`}
              name={`w.${p}`}
              type="number"
              min={0}
              max={100}
              step={1}
              defaultValue={Math.round(weights[p] * 100)}
              className="h-8 w-24"
            />
          </div>
        ))}
        <div className="space-y-1">
          <label htmlFor="healthyMin" className="text-muted-foreground block text-xs">
            Healthy from
          </label>
          <Input
            id="healthyMin"
            name="healthyMin"
            type="number"
            min={1}
            max={100}
            defaultValue={thresholds.healthyMin}
            className="h-8 w-24"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="watchMin" className="text-muted-foreground block text-xs">
            Watch from (below is At Risk)
          </label>
          <Input
            id="watchMin"
            name="watchMin"
            type="number"
            min={0}
            max={99}
            defaultValue={thresholds.watchMin}
            className="h-8 w-24"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="note" className="text-muted-foreground block text-xs">
          Why this change (optional)
        </label>
        <Input id="note" name="note" maxLength={500} className="max-w-lg" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>
          Preview back-test
        </Button>
        <Button type="submit" name="intent" value="save" variant="outline" disabled={pending}>
          Save as a new version
        </Button>
      </div>
      {state.preview ? (
        <div
          role="status"
          className="border-border space-y-1 rounded-md border p-3 text-sm"
          data-testid="model-preview"
        >
          <p className="font-medium">{state.preview.sentence}</p>
          <p className="text-muted-foreground text-xs">
            Mean lead{" "}
            {state.preview.meanLead === null ? "—" : `${Math.round(state.preview.meanLead)} days`} ·
            median lead{" "}
            {state.preview.medianLead === null
              ? "—"
              : `${Math.round(state.preview.medianLead)} days`}{" "}
            · not saved
          </p>
        </div>
      ) : null}
      <Result state={state} />
    </form>
  );
}
