import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NativeSelect } from "@/components/app/native-select";
import { OpportunityCard } from "@/components/expansion/opportunity";
import { Button } from "@/components/ui/button";
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
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Expansion</h1>
        <p className="text-muted-foreground text-sm">
          Accounts showing signs they could use more: seats or credits running out, a new team, fast
          growth, or a stated goal that needs more seats. A figure is always an estimate worked out
          from the account&apos;s own subscription; with no price on file there is no number.
        </p>
      </div>
      {ok ? (
        <p role="status" className="bg-muted text-foreground rounded-md px-3 py-2 text-sm">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}
      <form method="get" className="surface flex flex-wrap items-end gap-3 p-4 text-sm">
        <label className="flex flex-col gap-1">
          Status
          <NativeSelect name="status" defaultValue={list.status}>
            <option value="OPEN">Open and in progress</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_WORDS[s]}
              </option>
            ))}
            <option value="ALL">All</option>
          </NativeSelect>
        </label>
        <Button type="submit" variant="outline">
          Filter
        </Button>
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
          {list.page > 1 ? (
            <Link href={href(list.page - 1)} className="text-primary underline underline-offset-2">
              Previous
            </Link>
          ) : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? (
            <Link href={href(list.page + 1)} className="text-primary underline underline-offset-2">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
