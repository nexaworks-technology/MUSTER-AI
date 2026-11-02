"use client";

import { ActionForm } from "@/components/app/action-form";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeTaskAction, createTaskAction } from "@/modules/tasks/actions/tasks";

export function NewTaskForm({
  accountId,
  owners,
  defaultOwner,
}: {
  accountId?: string;
  owners: Array<{ membershipId: string; name: string }>;
  defaultOwner: string;
}) {
  return (
    <ActionForm
      action={createTaskAction}
      className="grid gap-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end"
    >
      {(pending) => (
        <>
          {accountId ? <input type="hidden" name="accountId" value={accountId} /> : null}
          <div className="space-y-1">
            <Label htmlFor="task-title">Task</Label>
            <Input id="task-title" name="title" required maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="task-owner">Owner</Label>
            <NativeSelect
              id="task-owner"
              name="ownerMembershipId"
              defaultValue={defaultOwner}
              className="w-full"
            >
              {owners.map((o) => (
                <option key={o.membershipId} value={o.membershipId}>
                  {o.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="task-due">Due</Label>
            <Input id="task-due" name="dueAt" type="date" />
          </div>
          <Button type="submit" disabled={pending}>
            Add task
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function CompleteTask({ taskId, title }: { taskId: string; title: string }) {
  return (
    <ActionForm action={completeTaskAction} className="flex items-center gap-2">
      {(pending) => (
        <>
          <input type="hidden" name="taskId" value={taskId} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending}
            aria-label={`Mark "${title}" done`}
          >
            Done
          </Button>
        </>
      )}
    </ActionForm>
  );
}
