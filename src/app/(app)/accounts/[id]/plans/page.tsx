import type { Metadata } from "next";
import { getAccountSuccessPlan } from "@/modules/success-plans/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Success Plans" };

export default async function AccountPlansPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const planView = await getAccountSuccessPlan(ctx, account.id);

  return (
    <div className="space-y-4" data-testid="account-plans">
      {!planView ? (
        <p className="text-muted-foreground text-sm">No success plan for this account.</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">{planView.plan.title}</h2>
              <span
                className="rounded border px-2 py-0.5 text-xs font-medium"
                data-testid="portal-sharing-badge"
              >
                {planView.plan.sharedWithPortal ? "Shared with customer portal" : "Internal only"}
              </span>
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Progress: <span className="font-medium text-foreground">{planView.progressPercent}%</span>
            </div>
          </div>

          <section aria-labelledby="goals-heading" className="space-y-2">
            <h3 id="goals-heading" className="text-base font-semibold">
              Goals ({planView.goals.length})
            </h3>
            {planView.goals.length === 0 ? (
              <p className="text-muted-foreground text-sm">No goals linked to this plan.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm" data-testid="goals-list">
                {planView.goals.map((goal) => (
                  <li key={goal.id} className="flex items-center justify-between p-3" data-testid="goal-item">
                    <span>{goal.text}</span>
                    <span className="text-muted-foreground text-xs uppercase">{goal.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
