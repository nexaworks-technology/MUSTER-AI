import type { Metadata, Route } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
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
        <EmptyState>Your role does not include outcome reports.</EmptyState>
      </section>
    );
  const rows = await listAccountOutcomes(ctx, account.id);
  return (
    <section aria-labelledby="outcomes" className="space-y-3">
      <h2 id="outcomes" className="text-base font-semibold">
        Outcomes
      </h2>
      {rows.length === 0 ? (
        <EmptyState>
          No risk or opportunity has been flagged on this account yet, so there is nothing to judge.
        </EmptyState>
      ) : (
        <div className="surface overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="account-outcomes">
            <caption className="sr-only">Outcome records for this account</caption>
            <thead>
              <tr>
                <th scope="col">Flagged</th>
                <th scope="col">Flag</th>
                <th scope="col">Team</th>
                <th scope="col">Day 7</th>
                <th scope="col">Day 30</th>
                <th scope="col">Day 90</th>
                <th scope="col">Proof</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.flaggedAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {r.flagType === "RISK" ? "Risk" : "Opportunity"}
                    {r.title ? `: ${r.title}` : ""}
                  </td>
                  <td>{r.actionTaken === "ACTED" ? "Acted" : "No action"}</td>
                  <td>{r.d7 ?? "Waiting"}</td>
                  <td>{r.d30 ?? "Waiting"}</td>
                  <td>{r.d90 ?? "Waiting"}</td>
                  <td>
                    <Link
                      href={`/reports/outcomes/${r.id}` as Route}
                      className="text-primary underline underline-offset-2"
                    >
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
