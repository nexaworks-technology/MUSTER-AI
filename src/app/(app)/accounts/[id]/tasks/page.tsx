import type { Metadata } from "next";
import { NewTaskForm } from "@/components/app/task-forms";
import { TaskList } from "@/components/app/task-list";
import { listOwners } from "@/modules/accounts/service";
import { listAccountTasks } from "@/modules/tasks/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Tasks" };

export default async function AccountTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const [tasks, owners] = await Promise.all([listAccountTasks(ctx, account.id), listOwners(ctx)]);
  return (
    <div className="space-y-4">
      {account.canEdit ? (
        <NewTaskForm
          accountId={account.id}
          owners={owners}
          defaultOwner={account.ownerMembershipId ?? ctx.membershipId}
        />
      ) : null}
      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks for this account.</p>
      ) : (
        <TaskList tasks={tasks} tz={ctx.workspace.timezone} now={new Date()} showAccount={false} />
      )}
    </div>
  );
}
