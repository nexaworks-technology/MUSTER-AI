import type { Metadata, Route } from "next";
import Link from "next/link";
import { after } from "next/server";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { BulkApprovals, type BulkRow } from "@/components/app/bulk-approvals";
import { EmptyState } from "@/components/app/empty-state";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { LEVEL_WORDS, sensitiveLabel, waitingFor } from "@/modules/approvals/schemas";
import { recordProductEvent } from "@/lib/pilot/capture";
import { approvalListQuery, listApprovals } from "@/modules/approvals/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Approvals" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Approvals (spec §5, §6F2): every draft or action waiting for a human yes or no. */
export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  after(() => recordProductEvent(ctx, { name: "approvals.opened" }));
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = approvalListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : approvalListQuery.parse({});
  const page = await listApprovals(ctx, query);
  const canDecide = Boolean(can(ctx, "approvals:decide"));
  const rows: BulkRow[] = page.rows.map((a) => ({
    id: a.id,
    accountName: a.account?.name ?? "Workspace Campaign",
    reason: a.reason,
    subject: a.outboundMessages[0]?.subject ?? null,
    levelLabel: a.isSensitive ? "Draft for approval · Always human" : LEVEL_WORDS[a.requiredLevel],
    sensitive: a.isSensitive ? sensitiveLabel(a.sensitiveReasons) : null,
    assignee: a.assignee?.user.name ?? a.assignee?.user.email ?? null,
    waiting: waitingFor(a.createdAt),
  }));
  const tab = (status: string, label: string) => {
    const active = query.status === status;
    return (
      <Link
        href={`/approvals?status=${status}` as Route}
        aria-current={active ? "page" : undefined}
        className={cn(
          "rounded-md px-3.5 py-1.5 text-xs sm:text-sm font-medium transition-all",
          active
            ? "bg-background text-foreground shadow-xs border border-border/80"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-section">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground text-sm">
          Nothing reaches a customer until a person approves it here.
        </p>
      </div>
      <nav aria-label="Approval status" className="inline-flex rounded-lg bg-muted/60 p-1 border border-border/60">
        {tab("PENDING", `Waiting (${query.status === "PENDING" ? page.total : "…"})`)}
        {tab("DECIDED", "Decided")}
      </nav>
      {query.status === "PENDING" ? (
        <BulkApprovals rows={rows} canDecide={canDecide} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6">No decided approvals yet.</EmptyState>
      ) : (
        <DataListCard>
          <ul className="divide-border divide-y overflow-hidden">
            {page.rows.map((a) => {
              const name = a.account?.name ?? "Workspace Campaign";
              const isApproved = a.status === "APPROVED";
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 p-4 text-sm hover:bg-muted/40 transition-colors"
                  data-testid="decided-row"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DataListAvatar name={name} size="sm" className="shrink-0" />
                    <div className="min-w-0">
                      <Link href={`/approvals/${a.id}` as Route} className="font-medium hover:underline text-foreground block truncate">
                        {a.account ? `${a.account.name}: ` : ""}
                        {a.reason}
                      </Link>
                      <span className="text-muted-foreground text-xs block">
                        {a.status.toLowerCase().replaceAll("_", " ")}
                      </span>
                    </div>
                  </div>
                  <StatusPill
                    variant={isApproved ? "success" : "danger"}
                    size="sm"
                  >
                    {a.status.toLowerCase().replaceAll("_", " ")}
                  </StatusPill>
                </li>
              );
            })}
          </ul>
        </DataListCard>
      )}
      {page.next !== null || page.cursor > 0 ? (
        <nav aria-label="Pages" className="flex items-center gap-3 text-xs sm:text-sm font-medium">
          {page.cursor > 0 ? (
            <Link
              href={
                `/approvals?status=${query.status}&cursor=${Math.max(0, page.cursor - 25)}` as Route
              }
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              <ArrowLeft className="size-3.5" />
              Previous
            </Link>
          ) : null}
          {page.next !== null ? (
            <Link
              href={`/approvals?status=${query.status}&cursor=${page.next}` as Route}
              className="inline-flex items-center gap-1.5 text-primary hover:underline ml-auto"
            >
              Next
              <ArrowRight className="size-3.5" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
