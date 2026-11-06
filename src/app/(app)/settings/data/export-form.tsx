"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { requestExportAction } from "@/modules/settings/actions/data-export";
import type { FormState } from "@/modules/settings/actions/shared";

export function ExportForm({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestExportAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={pending || disabled} data-testid="export-all-data">
        {pending ? "Starting…" : "Export all data"}
      </Button>
      {disabled ? (
        <p className="text-muted-foreground text-sm">An export is already running.</p>
      ) : null}
      <FormMessage state={state} />
    </form>
  );
}
