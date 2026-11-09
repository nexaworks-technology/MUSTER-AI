import type { Metadata, Route } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { PromiseTable } from "@/components/app/promise-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      className={`rounded-md px-3.5 py-1.5 text-xs sm:text-sm font-medium transition-all ${active ? "bg-background text-foreground shadow-xs border border-border/80" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-section">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Promises</h1>
        <p className="text-muted-foreground text-sm">
          Promises read from calls, emails and notes, each with the exact words, plus any added by
          hand. Late ones first, then ones with no owner.
        </p>
      </div>
      <nav aria-label="Promise views" className="inline-flex rounded-lg bg-muted/60 p-1 border border-border/60">
        {tab("/promises", "Open", status === "OPEN")}
        {tab("/promises?status=ALL", "All", status === "ALL")}
      </nav>
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
            className="text-primary underline underline-offset-2"
          >
            Next
          </Link>
        </nav>
      ) : null}
      {canEdit ? (
        <details className="surface p-4 text-sm">
          <summary className="cursor-pointer font-medium">Add a promise by hand</summary>
          <form action={createPromiseAction} className="mt-3 grid max-w-xl gap-3">
            <input type="hidden" name="returnTo" value="/promises" />
            <label>
              Account
              <NativeSelect name="accountId" required defaultValue="" className="mt-1 block w-full">
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              What was promised
              <Input name="what" required maxLength={300} className="mt-1 block" />
            </label>
            <label>
              Who promised
              <NativeSelect name="party" defaultValue="US" className="mt-1 block w-full">
                <option value="US">We did</option>
                <option value="CUSTOMER">The customer did</option>
              </NativeSelect>
            </label>
            <label>
              Due date (leave empty if none was given)
              <Input name="dueDate" type="date" className="mt-1 block w-auto" />
            </label>
            <label>
              Owner
              <NativeSelect name="ownerMembershipId" defaultValue="" className="mt-1 block w-full">
                <option value="">No owner</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit" className="w-fit">
              Add promise
            </Button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
