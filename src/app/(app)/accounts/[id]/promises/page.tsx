import type { Metadata } from "next";
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
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          Saved.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No promises on file for this account.</p>
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
