import type { Metadata } from "next";
import { OpportunityCard, WhitespacePanel } from "@/components/expansion/opportunity";
import { can } from "@/lib/auth/permissions";
import { getAccountExpansion } from "@/modules/expansion/service";
import { listMembers } from "@/modules/settings/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Expansion" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Account 360 › Expansion: this account's opportunities, and its whitespace with no money in it. */
export default async function ExpansionTab({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const { ctx } = await loadAccount(id);
  const data = await getAccountExpansion(ctx, id);
  const q = await searchParams;
  const members = can(ctx, "workspace:manageUsers") ? await listMembers(ctx) : [];
  const names = members
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({ id: m.id, name: m.user.name ?? m.user.email }));
  const returnTo = `/accounts/${id}/expansion`;
  return (
    <div className="space-y-6">
      {one(q.ok) ? (
        <p role="status" className="text-sm">
          {one(q.ok)}
        </p>
      ) : null}
      {one(q.error) ? (
        <p role="alert" className="text-sm">
          {one(q.error)}
        </p>
      ) : null}
      <section aria-labelledby="ws-h" className="space-y-2">
        <h2 id="ws-h" className="text-lg font-semibold">
          Whitespace
        </h2>
        <WhitespacePanel ws={data.whitespace} />
      </section>
      <section aria-labelledby="opp-h" className="space-y-2">
        <h2 id="opp-h" className="text-lg font-semibold">
          Opportunities
        </h2>
        {data.opportunities.length === 0 ? (
          <p className="text-sm">No expansion opportunity on this account.</p>
        ) : (
          data.opportunities.map((o) => (
            <OpportunityCard
              key={o.id}
              row={o}
              returnTo={returnTo}
              members={names}
              crmName={null}
              showAccount={false}
            />
          ))
        )}
      </section>
    </div>
  );
}
