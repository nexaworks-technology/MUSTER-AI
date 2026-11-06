import type { Metadata, Route } from "next";
import Link from "next/link";
import { after } from "next/server";
import { BulkApprovals, type BulkRow } from "@/components/app/bulk-approvals";
import { EmptyState } from "@/components/app/empty-state";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { LEVEL_WORDS, sensitiveLabel, waitingFor } from "@/modules/approvals/schemas";
import { recordProductEvent } from "@/lib/pilot/capture";
import { approvalListQuery, listApprovals } from "@/modules/approvals/service";

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
  const tab = (status: string, label: string) => (
    <Link
      href={`/approvals?status=${status}` as Route}
      aria-current={query.status === status ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${query.status === status ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-section">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground text-sm">
          Nothing reaches a customer until a person approves it here.
        </p>
      </div>
      <nav aria-label="Approval status" className="flex gap-1">
        {tab("PENDING", `Waiting (${query.status === "PENDING" ? page.total : "…"})`)}
        {tab("DECIDED", "Decided")}
      </nav>
      {query.status === "PENDING" ? (
        <BulkApprovals rows={rows} canDecide={canDecide} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6">No decided approvals yet.</EmptyState>
      ) : (
        <ul className="surface divide-border divide-y overflow-hidden">
          {page.rows.map((a) => (
            <li key={a.id} className="p-4 text-sm" data-testid="decided-row">
              <Link href={`/approvals/${a.id}` as Route} className="font-medium hover:underline">
                {a.account ? `${a.account.name}: ` : ""}
                {a.reason}
              </Link>
              <span className="text-muted-foreground ml-2">
                {a.status.toLowerCase().replaceAll("_", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page.next !== null || page.cursor > 0 ? (
        <nav aria-label="Pages" className="text-primary flex gap-4 text-sm font-medium">
          {page.cursor > 0 ? (
            <Link
              href={
                `/approvals?status=${query.status}&cursor=${Math.max(0, page.cursor - 25)}` as Route
              }
              className="hover:underline"
            >
              Previous
            </Link>
          ) : null}
          {page.next !== null ? (
            <Link
              href={`/approvals?status=${query.status}&cursor=${page.next}` as Route}
              className="hover:underline"
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
