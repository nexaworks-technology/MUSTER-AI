import type { Metadata, Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { markAllReadAction } from "@/modules/notifications/actions/notifications";
import { listMyNotifications } from "@/modules/notifications/service";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const items = await listMyNotifications(ctx);
  const unread = items.filter((n) => !n.readAt).length;
  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        {unread > 0 ? (
          <form action={markAllReadAction}>
            <Button type="submit" variant="outline" size="sm">
              Mark all read
            </Button>
          </form>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing here yet. Mentions and tasks assigned to you show up here.
        </p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {items.map((n) => (
            <li key={n.id} className="flex justify-between gap-2 p-3" data-testid="notification">
              <div>
                {!n.readAt ? <span className="sr-only">Unread: </span> : null}
                <span className={n.readAt ? "text-muted-foreground" : "font-medium"}>
                  {n.title}
                </span>
                <div className="text-muted-foreground text-xs">
                  {formatDateTime(n.createdAt, ctx.workspace.timezone)}
                </div>
              </div>
              {n.refType === "ReportDigest" || n.refType === "ReportDigestNotice" ? (
                <Link
                  href={(n.refType === "ReportDigest" ? "/reports/digest" : "/reports") as Route}
                  className="shrink-0 text-xs underline"
                >
                  Open
                </Link>
              ) : n.accountId ? (
                <Link
                  href={
                    n.refType === "Note"
                      ? `/accounts/${n.accountId}/notes`
                      : n.refType === "Task"
                        ? `/accounts/${n.accountId}/tasks#task-${n.refId}`
                        : n.refType === "Approval"
                          ? `/approvals/${n.refId}`
                          : n.refType === "OnboardingPlan"
                            ? `/accounts/${n.accountId}/onboarding`
                            : `/accounts/${n.accountId}`
                  }
                  className="shrink-0 text-xs underline"
                >
                  Open
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
