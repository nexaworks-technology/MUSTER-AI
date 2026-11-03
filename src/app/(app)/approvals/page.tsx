import type { Metadata, Route } from "next";
import Link from "next/link";
import { BulkApprovals, type BulkRow } from "@/components/app/bulk-approvals";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { LEVEL_WORDS, sensitiveLabel, waitingFor } from "@/modules/approvals/schemas";
import { approvalListQuery, listApprovals } from "@/modules/approvals/service";

export const metadata: Metadata = { title: "Approvals" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Approvals (spec §5, §6F2): every draft or action waiting for a human yes or no. */
export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = approvalListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : approvalListQuery.parse({});
  const page = await listApprovals(ctx, query);
  const canDecide = Boolean(can(ctx, "approvals:decide"));
  const rows: BulkRow[] = page.rows.map((a) => ({
    id: a.id,
    accountName: a.account.name,
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
      className={`rounded-md px-3 py-1 text-sm ${query.status === status ? "bg-muted font-medium" : "hover:underline"}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
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
        <p className="text-muted-foreground rounded-md border p-6 text-sm">
          No decided approvals yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {page.rows.map((a) => (
            <li key={a.id} className="p-3 text-sm" data-testid="decided-row">
              <Link href={`/approvals/${a.id}` as Route} className="font-medium hover:underline">
                {a.account.name}: {a.reason}
              </Link>
              <span className="text-muted-foreground ml-2">
                {a.status.toLowerCase().replaceAll("_", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page.next !== null || page.cursor > 0 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
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
