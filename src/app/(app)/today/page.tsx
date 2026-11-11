import type { Metadata, Route } from "next";
import Link from "next/link";
import { after } from "next/server";
import {
  FileCheck,
  AlertTriangle,
  RefreshCw,
  CircleDollarSign,
  ArrowRight,
  Plus,
} from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { DataListCard, DataListAvatar, DataListRowActions } from "@/components/app/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatMoney } from "@/lib/money";
import { recordProductEvent } from "@/lib/pilot/capture";
import { healthOverview } from "@/modules/health/service";
import { listRenewals } from "@/modules/renewals/service";
import { countMyRenewalsDue, getToday, SECTIONS } from "@/modules/today/service";

export const metadata: Metadata = { title: "Today" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const hrefFor = (i: { itemType: string; refId: string; accountId: string | null }): string => {
  switch (i.itemType) {
    case "TASK":
      return i.accountId
        ? `/accounts/${i.accountId}/tasks#task-${i.refId}`
        : `/tasks#task-${i.refId}`;
    case "SIGNAL":
      return `/accounts/${i.accountId}/signals#signal-${i.refId}`;
    case "APPROVAL":
      return `/approvals/${i.refId}`;
    default:
      return `/accounts/${i.accountId}`;
  }
};

const VIEW_ALL_LINKS: Record<string, { href: Route; label: string }> = {
  TASK: { href: "/tasks", label: "View all tasks" },
  SIGNAL: { href: "/health", label: "View health" },
  APPROVAL: { href: "/approvals", label: "View approvals" },
  RENEWAL: { href: "/renewals", label: "View renewals" },
};

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Today (spec §5, §6F1, Design 2.0 Prototype):
 * Rebuilt as a modern premium dashboard. What needs this member today,
 * ranked by money × urgency with the reason shown on every item.
 * Real data sources for all stats: approvals waiting, accounts at risk,
 * renewals due in 30 days, and ARR at risk.
 */
export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  const ctx = (await resolveWorkspaceContext(session))!;
  after(() => recordProductEvent(ctx, { name: "today.opened" }));

  const sp = await searchParams;
  const cursors = Object.fromEntries(
    SECTIONS.map((s) => [
      s.key,
      Math.max(0, Number(Array.isArray(sp[s.key]) ? sp[s.key]![0] : (sp[s.key] ?? 0)) || 0),
    ]),
  );

  // The card and the "next 90 days" list read the same Renewal records as the Renewals page, on
  // the member's own accounts ("only for my accounts", spec §5). `renewalsAll90` is the Renewals
  // page's own total, shown only to explain an empty own-book list.
  const [sections, health, renewalsDue30, renewalsAll90] = await Promise.all([
    getToday(ctx, { cursors }),
    healthOverview(ctx),
    countMyRenewalsDue(ctx, 30),
    listRenewals(ctx, { days: 90 }),
  ]);

  const empty = sections.every((s) => s.total === 0);
  const now = new Date();
  const userFirst = session.user.name?.split(" ")[0] ?? session.user.email ?? "there";
  const greeting = `${greetingFor(now)}, ${userFirst}`;

  const dateString = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: ctx.workspace.timezone || "America/New_York",
  }).format(now);

  const approvalsSection = sections.find((s) => s.key === "APPROVAL");
  const pendingApprovalsCount = approvalsSection?.total ?? 0;
  const accountsAtRiskCount = health.bands.AT_RISK.count;
  const renewalsDue30Count = renewalsDue30;
  const arrAtRiskMinor = health.bands.AT_RISK.arrMinor;

  return (
    <div className="space-y-6">
      {/* S3: Header Row (Greeting + Date + Primary Action) */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-foreground text-2xl font-bold tracking-tight" aria-label="Today">{greeting}</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            <span className="text-foreground font-medium">{dateString}</span> · Your accounts only,
            ranked by account value × urgency.
            {ctx.canViewRevenue
              ? ""
              : " You don't have revenue access, so values are not shown; the order is the same."}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 shadow-2xs">
            <Link href="/approvals">
              <FileCheck className="text-primary size-3.5" />
              <span>Approvals</span>
              {pendingApprovalsCount > 0 ? (
                <span className="bg-primary/10 text-primary py-0.2 rounded-full px-1.5 text-[10px] font-semibold">
                  {pendingApprovalsCount}
                </span>
              ) : null}
            </Link>
          </Button>
          <Button asChild size="sm" className="h-8 gap-1.5 shadow-xs">
            <Link href="/tasks">
              <Plus className="size-3.5" />
              <span>New task</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* S3: KPI Stat Row (Real data sources, no invented trends) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Approvals Waiting */}
        <Link
          href="/approvals"
          className="group focus-visible:ring-ring block rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        >
          <Card className="surface-interactive group-hover:border-primary/40 h-full p-4 transition-all duration-150">
            <CardContent className="space-y-2 p-0">
              <div className="text-muted-foreground flex items-center justify-between">
                <span className="text-xs font-medium">Approvals waiting</span>
                <FileCheck className="text-primary size-4 transition-transform group-hover:scale-110" />
              </div>
              <div className="text-foreground text-2xl font-bold tracking-tight tabular-nums">
                {pendingApprovalsCount}
              </div>
              <p className="text-muted-foreground truncate text-[11px]">Pending your decision</p>
            </CardContent>
          </Card>
        </Link>

        {/* Accounts at Risk */}
        <Link
          href="/accounts?health=AT_RISK"
          className="group focus-visible:ring-ring block rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        >
          <Card className="surface-interactive group-hover:border-warning/40 h-full p-4 transition-all duration-150">
            <CardContent className="space-y-2 p-0">
              <div className="text-muted-foreground flex items-center justify-between">
                <span className="text-xs font-medium">Accounts at risk</span>
                <AlertTriangle className="text-warning size-4 transition-transform group-hover:scale-110" />
              </div>
              <div className="text-foreground text-2xl font-bold tracking-tight tabular-nums">
                {accountsAtRiskCount}
              </div>
              <p className="text-muted-foreground truncate text-[11px]">In your assigned book</p>
            </CardContent>
          </Card>
        </Link>

        {/* Renewals Due in 30 Days */}
        <Link
          href="/renewals?days=30"
          className="group focus-visible:ring-ring block rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        >
          <Card className="surface-interactive h-full p-4 transition-all duration-150 group-hover:border-sky-500/40">
            <CardContent className="space-y-2 p-0">
              <div className="text-muted-foreground flex items-center justify-between">
                <span className="text-xs font-medium">Renewals in 30 days</span>
                <RefreshCw className="size-4 text-sky-600 dark:text-sky-400 transition-transform group-hover:scale-110" />
              </div>
              <div className="text-foreground text-2xl font-bold tracking-tight tabular-nums">
                {renewalsDue30Count}
              </div>
              <p className="text-muted-foreground truncate text-[11px]">On your own accounts</p>
            </CardContent>
          </Card>
        </Link>

        {/* ARR at Risk */}
        <Link
          href={ctx.canViewRevenue ? "/revenue" : "/accounts?health=AT_RISK"}
          className="group focus-visible:ring-ring block rounded-lg focus-visible:ring-2 focus-visible:outline-none"
        >
          <Card className="surface-interactive group-hover:border-danger/40 h-full p-4 transition-all duration-150">
            <CardContent className="space-y-2 p-0">
              <div className="text-muted-foreground flex items-center justify-between">
                <span className="text-xs font-medium">ARR at risk</span>
                <CircleDollarSign className="text-danger size-4 transition-transform group-hover:scale-110" />
              </div>
              <div className="text-foreground text-2xl font-bold tracking-tight tabular-nums">
                {ctx.canViewRevenue
                  ? formatMoney({
                      minor: arrAtRiskMinor ?? 0n,
                      currency: ctx.workspace.baseCurrency,
                    })
                  : "Locked"}
              </div>
              <p className="text-muted-foreground truncate text-[11px]">
                {ctx.canViewRevenue ? "Total at-risk contract value" : "Revenue access required"}
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Global empty state if nothing needs attention */}
      {empty ? (
        <EmptyState className="py-8" data-testid="today-empty">
          Nothing needs you today.
        </EmptyState>
      ) : null}

      {/* S3 & S4: Today Sections Restyled as Premium Cards */}
      <div className="space-y-5">
        {sections.map((s) => {
          const viewAll = VIEW_ALL_LINKS[s.key];

          return (
            <section
              key={s.key}
              aria-labelledby={`today-${s.key}`}
              className="space-y-2.5"
              data-testid={`today-${s.key}`}
            >
              <DataListCard
                header={
                  <div className="border-border bg-card/70 flex items-center justify-between border-b px-4 py-3">
                    <div className="flex items-center gap-2">
                      <h2
                        id={`today-${s.key}`}
                        className="text-foreground text-sm font-semibold tracking-tight"
                      >
                        {s.label}{" "}
                        <span className="text-muted-foreground font-normal">({s.total})</span>
                      </h2>
                    </div>
                    {viewAll ? (
                      <Link
                        href={viewAll.href}
                        className="text-primary hover:text-primary/80 flex items-center gap-1 text-xs font-medium hover:underline"
                      >
                        <span>{viewAll.label}</span>
                        <ArrowRight aria-hidden="true" className="size-3" />
                      </Link>
                    ) : null}
                  </div>
                }
              >
                {s.items.length === 0 ? (
                  <div className="p-4">
                    <EmptyState>
                      {s.key === "MEETING"
                        ? "No calendar connected. Meetings appear here once one is."
                        : s.key === "RENEWAL" && renewalsAll90.total > 0
                          ? `None of your own accounts renew in the next 90 days. The Renewals page lists ${renewalsAll90.total} across everyone you can see.`
                          : "Nothing here."}
                    </EmptyState>
                  </div>
                ) : (
                  <ol className="divide-border divide-y overflow-hidden">
                    {s.items.map((i) => (
                      <li
                        key={i.id}
                        className="hover:bg-muted/40 group relative flex items-start justify-between gap-3 px-4 py-3 text-sm transition-colors"
                        data-testid="today-item"
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <DataListAvatar
                            name={i.accountName ?? i.title}
                            size="md"
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-1.5">
                              <Link
                                href={hrefFor(i) as Route}
                                className="text-foreground hover:text-primary font-medium tracking-tight hover:underline"
                              >
                                {i.title}
                              </Link>
                              {i.accountName && i.itemType !== "RENEWAL" ? (
                                <span className="text-muted-foreground text-xs">
                                  · {i.accountName}
                                </span>
                              ) : null}
                            </div>
                            <p
                              className="text-muted-foreground text-xs leading-relaxed"
                              data-testid="today-reasons"
                            >
                              {i.reasons.map((r) => r.label).join(" × ")}
                            </p>
                          </div>
                        </div>

                        <DataListRowActions>
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="text-primary hover:text-primary h-7 px-2 text-xs font-medium"
                          >
                            <Link href={hrefFor(i) as Route}>
                              <span>Open</span>
                              <ArrowRight aria-hidden="true" className="ml-1 size-3" />
                            </Link>
                          </Button>
                        </DataListRowActions>
                      </li>
                    ))}
                  </ol>
                )}
              </DataListCard>

              {/* Pagination Nav */}
              {s.next !== null || s.cursor > 0 ? (
                <nav
                  aria-label={`${s.label} pages`}
                  className="text-primary flex gap-4 px-1 text-xs font-medium"
                >
                  {s.cursor > 0 ? (
                    <Link
                      href={`/today?${s.key}=${Math.max(0, s.cursor - 25)}` as Route}
                      className="hover:underline"
                    >
                      Previous
                    </Link>
                  ) : null}
                  {s.next !== null ? (
                    <Link href={`/today?${s.key}=${s.next}` as Route} className="hover:underline">
                      Next
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
