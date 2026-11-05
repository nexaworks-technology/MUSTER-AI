import Link from "next/link";
import { CompleteTask } from "@/components/app/task-forms";
import { formatCalendarDate, formatDate } from "@/lib/format";

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
    <ul className="divide-border border-border divide-y rounded-md border text-sm">
      {tasks.map((t) => {
        const overdue = t.status === "OPEN" && t.dueAt !== null && t.dueAt < now;
        return (
          <li
            key={t.id}
            id={`task-${t.id}`}
            className="target:bg-muted flex scroll-mt-4 flex-wrap items-center justify-between gap-2 p-3"
            data-testid="task"
          >
            <div>
              <div
                className={
                  t.status === "DONE" ? "text-muted-foreground line-through" : "font-medium"
                }
              >
                {t.title}
              </div>
              <div className="text-muted-foreground text-xs">
                {showAccount && t.account ? (
                  <>
                    <Link href={`/accounts/${t.account.id}`} className="underline">
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
                  <span className="ml-1 text-[var(--risk-at-risk)]">· overdue</span>
                ) : null}
              </div>
            </div>
            {t.status === "OPEN" ? <CompleteTask taskId={t.id} title={t.title} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
