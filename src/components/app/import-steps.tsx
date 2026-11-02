"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import {
  confirmImportAction,
  previewImportAction,
  type ActionState,
} from "@/modules/imports/actions/imports";

export function MappingForm({
  jobId,
  headers,
  fields,
  mapping,
  disabled,
}: {
  jobId: string;
  headers: string[];
  fields: Array<{ key: string; label: string; required: boolean }>;
  mapping: Record<string, string>;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(previewImportAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <div
            key={f.key}
            className="border-border flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
          >
            <label htmlFor={`map-${f.key}`}>
              {f.label}
              {f.required ? <span className="text-muted-foreground"> (required)</span> : null}
            </label>
            <NativeSelect
              id={`map-${f.key}`}
              name={`map:${f.key}`}
              defaultValue={mapping[f.key] ?? ""}
              disabled={disabled}
            >
              <option value="">Not in file</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </NativeSelect>
          </div>
        ))}
      </div>
      <Button type="submit" variant="outline" disabled={pending || disabled}>
        {pending ? "Checking every row…" : "Preview (nothing is imported yet)"}
      </Button>
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

export function ConfirmImport({ jobId, label }: { jobId: string; label: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(confirmImportAction, {});
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** While the background run is queued or running, refresh the page every two seconds. */
export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
