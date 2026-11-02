import type { Metadata } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatArr, formatDate, RESTRICTED } from "@/lib/format";
import {
  accountListQuery,
  STAGE_LABELS,
  STAGES,
  TIER_LABELS,
  TIERS,
} from "@/modules/accounts/schemas";
import { listAccounts, listOwners } from "@/modules/accounts/service";

export const metadata: Metadata = { title: "Accounts" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(params: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? "") : (v ?? "")]),
  );
}

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const raw = single(await searchParams);
  const parsed = accountListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : accountListQuery.parse({});
  const [page, owners] = await Promise.all([listAccounts(ctx, query), listOwners(ctx)]);
  const tz = ctx.workspace.timezone;

  const pageHref = (cursor: string) => ({
    pathname: "/accounts" as const,
    query: { ...raw, cursor },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <form
        method="get"
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label="Filter accounts"
      >
        <div className="space-y-1">
          <label htmlFor="q" className="text-muted-foreground text-xs">
            Search
          </label>
          <Input
            id="q"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Name or domain"
            className="w-56"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="tier" className="text-muted-foreground block text-xs">
            Tier
          </label>
          <NativeSelect id="tier" name="tier" defaultValue={query.tier ?? ""}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="stage" className="text-muted-foreground block text-xs">
            Stage
          </label>
          <NativeSelect id="stage" name="stage" defaultValue={query.stage ?? ""}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="owner" className="text-muted-foreground block text-xs">
            Owner
          </label>
          <NativeSelect id="owner" name="owner" defaultValue={query.owner ?? ""}>
            <option value="">Anyone</option>
            <option value="none">No owner</option>
            {owners.map((o) => (
              <option key={o.membershipId} value={o.membershipId}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="sort" className="text-muted-foreground block text-xs">
            Sort by
          </label>
          <NativeSelect id="sort" name="sort" defaultValue={query.sort}>
            <option value="name">Name</option>
            {page.arrVisible ? <option value="arr">ARR</option> : null}
            <option value="lastTouch">Last touch</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="dir" className="text-muted-foreground block text-xs">
            Order
          </label>
          <NativeSelect id="dir" name="dir" defaultValue={query.dir}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Link href="/accounts" className="py-2 text-sm underline">
          Clear
        </Link>
      </form>

      {!parsed.success ? (
        <p role="alert" className="text-destructive text-sm">
          Some filters were not valid and were ignored.
        </p>
      ) : null}

      <p className="text-muted-foreground text-sm" aria-live="polite">
        {page.total === 0
          ? "No accounts match these filters."
          : `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`}
      </p>

      {page.rows.length > 0 ? (
        <div className="border-border overflow-x-auto rounded-md border">
          <table className="w-full min-w-[44rem] text-sm">
            <caption className="sr-only">Accounts</caption>
            <thead className="bg-muted text-muted-foreground text-left text-xs">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Tier
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Stage
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Owner
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  ARR
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Last touch
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((a) => (
                <tr key={a.id} className="border-border border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{a.name}</span>
                    {a.domain ? (
                      <div className="text-muted-foreground text-xs">{a.domain}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{TIER_LABELS[a.tier]}</td>
                  <td className="px-3 py-2">{STAGE_LABELS[a.lifecycleStage]}</td>
                  <td className="px-3 py-2">
                    {a.ownerName ?? <span className="text-muted-foreground">No owner</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {page.arrVisible ? (
                      formatArr(a.arr)
                    ) : (
                      <span className="text-muted-foreground">{RESTRICTED}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{formatDate(a.lastTouchAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <nav aria-label="Pages" className="flex gap-3 text-sm">
        {page.prevCursor !== null ? (
          <Link href={pageHref(page.prevCursor)} className="underline">
            Previous
          </Link>
        ) : null}
        {page.nextCursor !== null ? (
          <Link href={pageHref(page.nextCursor)} className="underline">
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
