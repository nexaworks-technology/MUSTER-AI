import type { Metadata } from "next";
import Link from "next/link";
import { NewTaskForm } from "@/components/app/task-forms";
import { TaskList } from "@/components/app/task-list";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listOwners } from "@/modules/accounts/service";
import { listMyTasks } from "@/modules/tasks/service";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const show = (await searchParams).show === "done" ? "DONE" : "OPEN";
  const [tasks, owners] = await Promise.all([listMyTasks(ctx, show), listOwners(ctx)]);
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">My tasks</h1>
      <nav aria-label="Task filter" className="flex gap-3 text-sm">
        <Link
          href="/tasks"
          aria-current={show === "OPEN" ? "page" : undefined}
          className={show === "OPEN" ? "font-medium" : "underline"}
        >
          Open
        </Link>
        <Link
          href={{ pathname: "/tasks", query: { show: "done" } }}
          aria-current={show === "DONE" ? "page" : undefined}
          className={show === "DONE" ? "font-medium" : "underline"}
        >
          Done
        </Link>
      </nav>
      {can(ctx, "accounts:edit") ? (
        <NewTaskForm owners={owners} defaultOwner={ctx.membershipId} />
      ) : null}
      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {show === "OPEN" ? "You have no open tasks." : "No completed tasks yet."}
        </p>
      ) : (
        <TaskList tasks={tasks} tz={ctx.workspace.timezone} now={new Date()} showAccount />
      )}
    </div>
  );
}
