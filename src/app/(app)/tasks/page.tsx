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
    <div className="space-y-section max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
      <nav aria-label="Task filter" className="flex gap-2 text-sm">
        <Link
          href="/tasks"
          aria-current={show === "OPEN" ? "page" : undefined}
          className={`rounded-md px-3 py-1 ${show === "OPEN" ? "bg-accent text-accent-foreground font-medium" : "text-foreground hover:bg-hover"}`}
        >
          Open
        </Link>
        <Link
          href={{ pathname: "/tasks", query: { show: "done" } }}
          aria-current={show === "DONE" ? "page" : undefined}
          className={`rounded-md px-3 py-1 ${show === "DONE" ? "bg-accent text-accent-foreground font-medium" : "text-foreground hover:bg-hover"}`}
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
