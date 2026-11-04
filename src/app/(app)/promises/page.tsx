import type { Metadata, Route } from "next";
import Link from "next/link";
import { PromiseTable } from "@/components/app/promise-table";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { createPromiseAction } from "@/modules/promises/actions/promises";
import { listOwnerChoices, listPromises } from "@/modules/promises/service";
import { listAssignableAccounts } from "@/modules/inbox/service";

export const metadata: Metadata = { title: "Promises" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const DONE = {
  created: "Promise added.",
  owner: "Owner saved.",
  kept: "Marked kept, with your note as the evidence.",
} as const;

/** Promise Tracker (spec §6D, §6E7): what we and our customers promised, late first. Status is computed from dates and records. */
export default async function PromisesPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const sp = await searchParams;
  const status = first(sp.status) === "ALL" ? "ALL" : "OPEN";
  const canEdit = Boolean(can(ctx, "accounts:edit"));
  const [{ rows, nextCursor }, owners, accounts] = await Promise.all([
    listPromises(ctx, { status, ...(first(sp.cursor) ? { cursor: first(sp.cursor)! } : {}) }),
    listOwnerChoices(ctx),
    canEdit ? listAssignableAccounts(ctx) : Promise.resolve([]),
  ]);
  const done = DONE[(first(sp.done) ?? "") as keyof typeof DONE];
  const error = first(sp.error);
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href as Route}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1 text-sm ${active ? "bg-muted font-medium" : "hover:underline"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Promises</h1>
        <p className="text-muted-foreground text-sm">
          Promises read from calls, emails and notes, each with the exact words, plus any added by
          hand. Late ones first, then ones with no owner.
        </p>
      </div>
      <nav aria-label="Promise views" className="flex gap-1">
        {tab("/promises", "Open", status === "OPEN")}
        {tab("/promises?status=ALL", "All", status === "ALL")}
      </nav>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {done}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="promises-empty">
          No promises on file.
        </p>
      ) : (
        <PromiseTable rows={rows} owners={owners} returnTo="/promises" canEdit={canEdit} />
      )}
      {nextCursor ? (
        <nav aria-label="Pages" className="text-sm">
          <Link
            href={{ pathname: "/promises", query: { status, cursor: nextCursor } }}
            className="underline"
          >
            Next
          </Link>
        </nav>
      ) : null}
      {canEdit ? (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Add a promise by hand</summary>
          <form action={createPromiseAction} className="mt-3 grid max-w-xl gap-3">
            <input type="hidden" name="returnTo" value="/promises" />
            <label>
              Account
              <select
                name="accountId"
                required
                defaultValue=""
                className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1"
              >
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              What was promised
              <input
                name="what"
                required
                maxLength={300}
                className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1"
              />
            </label>
            <label>
              Who promised
              <select
                name="party"
                defaultValue="US"
                className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1"
              >
                <option value="US">We did</option>
                <option value="CUSTOMER">The customer did</option>
              </select>
            </label>
            <label>
              Due date (leave empty if none was given)
              <input
                name="dueDate"
                type="date"
                className="border-input bg-background mt-1 block rounded-md border px-2 py-1"
              />
            </label>
            <label>
              Owner
              <select
                name="ownerMembershipId"
                defaultValue=""
                className="border-input bg-background mt-1 block w-full rounded-md border px-2 py-1"
              >
                <option value="">No owner</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="bg-primary text-primary-foreground w-fit rounded-md px-3 py-1"
            >
              Add promise
            </button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
