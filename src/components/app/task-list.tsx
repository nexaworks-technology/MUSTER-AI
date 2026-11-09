import Link from "next/link";
import { CompleteTask } from "@/components/app/task-forms";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { formatCalendarDate, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TaskRow {
  id: string;
  title: string;
  status: "OPEN" | "DONE" | "CANCELLED";
  dueAt: Date | null;
  completedAt: Date | null;
  account: { id: string; name: string } | null;
  owner: { user: { name: string | null; email: string } } | null;
}

/** Task list shared by /tasks and the Account 360 Tasks tab. Overdue items are flagged. */
export function TaskList({
  tasks,
  tz,
  now,
  showAccount,
}: {
  tasks: TaskRow[];
  tz: string;
  now: Date;
  showAccount: boolean;
}) {
  return (
    <DataListCard>
      <ul className="divide-border divide-y overflow-hidden text-sm">
        {tasks.map((t) => {
          const overdue = t.status === "OPEN" && t.dueAt !== null && t.dueAt < now;
          const avatarName = t.account?.name ?? t.owner?.user.name ?? "Task";
          return (
            <li
              key={t.id}
              id={`task-${t.id}`}
              className={cn(
                "group flex scroll-mt-4 flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/40",
                "target:bg-muted/60",
              )}
              data-testid="task"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <DataListAvatar name={avatarName} size="sm" className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div
                    className={
                      t.status === "DONE"
                        ? "text-muted-foreground line-through font-normal text-sm"
                        : "font-medium text-foreground text-sm"
                    }
                  >
                    {t.title}
                  </div>
                  <div className="text-muted-foreground text-xs mt-0.5">
                    {showAccount && t.account ? (
                      <>
                        <Link
                          href={`/accounts/${t.account.id}`}
                          className="text-primary underline underline-offset-2"
                        >
                          {t.account.name}
                        </Link>
                        {" · "}
                      </>
                    ) : null}
                    {t.owner ? (t.owner.user.name ?? t.owner.user.email) : "Unassigned"}
                    {" · "}
                    {t.status === "DONE"
                      ? `done ${formatDate(t.completedAt, tz)}`
                      : t.dueAt
                        ? `due ${formatCalendarDate(t.dueAt)}`
                        : "no due date"}
                    {overdue ? (
                      <span className="text-risk-at-risk ml-1 font-medium">· overdue</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                {overdue ? (
                  <StatusPill variant="atRisk" size="sm">
                    Overdue
                  </StatusPill>
                ) : t.status === "DONE" ? (
                  <StatusPill variant="success" size="sm">
                    Done
                  </StatusPill>
                ) : null}
                {t.status === "OPEN" ? <CompleteTask taskId={t.id} title={t.title} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {tasks.length >= 100 ? (
        <div
          className="border-t border-border/80 px-4 py-2.5 text-xs text-muted-foreground bg-muted/20"
          data-testid="tasks-truncation-label"
        >
          Showing first 100
        </div>
      ) : null}
    </DataListCard>
  );
}
