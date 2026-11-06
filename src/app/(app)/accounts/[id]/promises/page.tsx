import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { PromiseTable } from "@/components/app/promise-table";
import { can } from "@/lib/auth/permissions";
import { listOwnerChoices, listPromises } from "@/modules/promises/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Promises" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AccountPromisesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, account } = await loadAccount(id);
  const [{ rows }, owners] = await Promise.all([
    listPromises(ctx, { status: "ALL", accountId: account.id }),
    listOwnerChoices(ctx),
  ]);
  const error = first(sp.error);
  const done = first(sp.done);
  return (
    <div className="space-y-section">
      {error ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}
      {done ? (
        <p
          role="status"
          className="bg-success-soft text-success-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          Saved.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState>No promises on file for this account.</EmptyState>
      ) : (
        <PromiseTable
          rows={rows}
          owners={owners}
          returnTo={`/accounts/${account.id}/promises`}
          canEdit={Boolean(can(ctx, "accounts:edit"))}
          showAccount={false}
        />
      )}
    </div>
  );
}
