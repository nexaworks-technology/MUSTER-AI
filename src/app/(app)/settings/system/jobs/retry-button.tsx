"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { retryJobAction } from "@/modules/settings/actions/system-jobs";
import type { FormState } from "@/modules/settings/actions/shared";

export function RetryJobButton({ queue, jobId }: { queue: string; jobId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(retryJobAction, {});
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="queue" value={queue} />
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Retrying…" : "Retry"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
