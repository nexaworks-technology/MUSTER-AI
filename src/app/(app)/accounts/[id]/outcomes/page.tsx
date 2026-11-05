import type { Metadata, Route } from "next";
import Link from "next/link";
import { can } from "@/lib/auth/permissions";
import { listAccountOutcomes } from "@/modules/outcomes/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Outcomes" };

/** Account 360 › Outcomes: every flag on this account and what its checkpoints found. */
export default async function AccountOutcomesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  if (!can(ctx, "reports:view"))
    return (
      <section aria-labelledby="outcomes" className="space-y-3">
        <h2 id="outcomes" className="text-base font-semibold">
          Outcomes
        </h2>
        <p className="text-sm">Your role does not include outcome reports.</p>
      </section>
    );
  const rows = await listAccountOutcomes(ctx, account.id);
  return (
    <section aria-labelledby="outcomes" className="space-y-3">
      <h2 id="outcomes" className="text-base font-semibold">
        Outcomes
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No risk or opportunity has been flagged on this account yet, so there is nothing to judge.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="account-outcomes">
            <caption className="sr-only">Outcome records for this account</caption>
            <thead>
              <tr className="text-muted-foreground border-b text-xs">
                <th scope="col" className="py-1 pr-4 font-normal">
                  Flagged
                </th>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Flag
                </th>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Team
                </th>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Day 7
                </th>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Day 30
                </th>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Day 90
                </th>
                <th scope="col" className="py-1 font-normal">
                  Proof
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-1 pr-4">{r.flaggedAt.toISOString().slice(0, 10)}</td>
                  <td className="py-1 pr-4">
                    {r.flagType === "RISK" ? "Risk" : "Opportunity"}
                    {r.title ? `: ${r.title}` : ""}
                  </td>
                  <td className="py-1 pr-4">{r.actionTaken === "ACTED" ? "Acted" : "No action"}</td>
                  <td className="py-1 pr-4">{r.d7 ?? "Waiting"}</td>
                  <td className="py-1 pr-4">{r.d30 ?? "Waiting"}</td>
                  <td className="py-1 pr-4">{r.d90 ?? "Waiting"}</td>
                  <td className="py-1">
                    <Link href={`/reports/outcomes/${r.id}` as Route} className="underline">
                      Save record
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
