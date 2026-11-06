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
    <div className="space-y-section max-w-2xl">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
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
        <ul className="surface divide-border divide-y text-sm">
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
                  className="text-primary shrink-0 text-xs underline underline-offset-2"
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
                  className="text-primary shrink-0 text-xs underline underline-offset-2"
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
