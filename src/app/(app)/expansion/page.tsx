import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpportunityCard } from "@/components/expansion/opportunity";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listOpportunities, STATUS_WORDS, STATUSES } from "@/modules/expansion/service";
import { listMembers } from "@/modules/settings/service";

export const metadata: Metadata = { title: "Expansion" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Expansion (spec §5): opportunities found by rules from usage, people and goals. Each names the
 * signals behind it. Any figure is an estimate worked out from the account's own subscription, with
 * the method shown, and an account with no price on file shows no number at all.
 */
export default async function ExpansionPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();
  const params = await searchParams;
  const status = one(params.status) ?? "OPEN";
  const page = Number(one(params.page) ?? 1) || 1;
  const list = await listOpportunities(ctx, { status, page });
  const members = can(ctx, "workspace:manageUsers") ? await listMembers(ctx) : [];
  const names = members
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({ id: m.id, name: m.user.name ?? m.user.email }));
  const ok = one(params.ok);
  const error = one(params.error);
  const href = (p: number) =>
    `/expansion?${new URLSearchParams({ status: list.status, page: String(p) }).toString()}` as Route;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Expansion</h1>
      <p className="text-muted-foreground text-sm">
        Accounts showing signs they could use more: seats or credits running out, a new team, fast
        growth, or a stated goal that needs more seats. A figure is always an estimate worked out
        from the account&apos;s own subscription; with no price on file there is no number.
      </p>
      {ok ? (
        <p role="status" className="text-sm">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      <form method="get" className="flex items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Status
          <select
            name="status"
            defaultValue={list.status}
            className="border-input rounded-md border px-2 py-1"
          >
            <option value="OPEN">Open and in progress</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_WORDS[s]}
              </option>
            ))}
            <option value="ALL">All</option>
          </select>
        </label>
        <button type="submit" className="border-input rounded-md border px-3 py-1">
          Filter
        </button>
      </form>
      {list.rows.length === 0 ? (
        <p className="text-sm">No expansion opportunities with this status.</p>
      ) : (
        <div className="space-y-3">
          {list.rows.map((r) => (
            <OpportunityCard
              key={r.id}
              row={r}
              returnTo="/expansion"
              members={names}
              crmName={list.crm?.name ?? null}
              showAccount
            />
          ))}
        </div>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {list.page > 1 ? <Link href={href(list.page - 1)}>Previous</Link> : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? <Link href={href(list.page + 1)}>Next</Link> : null}
        </nav>
      ) : null}
    </div>
  );
}
