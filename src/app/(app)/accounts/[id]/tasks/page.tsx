import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
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
    <div className="space-y-section">
      {account.canEdit ? (
        <div className="surface p-4">
          <NewTaskForm
            accountId={account.id}
            owners={owners}
            defaultOwner={account.ownerMembershipId ?? ctx.membershipId}
          />
        </div>
      ) : null}
      {tasks.length === 0 ? (
        <EmptyState>No tasks for this account.</EmptyState>
      ) : (
        <TaskList tasks={tasks} tz={ctx.workspace.timezone} now={new Date()} showAccount={false} />
      )}
    </div>
  );
}
