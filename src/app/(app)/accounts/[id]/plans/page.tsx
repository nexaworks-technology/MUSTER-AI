import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { getAccountSuccessPlan } from "@/modules/success-plans/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Success Plans" };

export default async function AccountPlansPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const planView = await getAccountSuccessPlan(ctx, account.id);

  return (
    <div className="space-y-section" data-testid="account-plans">
      {!planView ? (
        <EmptyState>No success plan for this account.</EmptyState>
      ) : (
        <div className="space-y-section">
          <div className="surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">{planView.plan.title}</h2>
              <Badge
                variant={planView.plan.sharedWithPortal ? "accent" : "neutral"}
                data-testid="portal-sharing-badge"
              >
                {planView.plan.sharedWithPortal ? "Shared with customer portal" : "Internal only"}
              </Badge>
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              Progress:{" "}
              <span className="text-foreground font-medium">{planView.progressPercent}%</span>
            </div>
          </div>

          <section aria-labelledby="goals-heading" className="space-y-3">
            <h3 id="goals-heading" className="text-base font-semibold">
              Goals ({planView.goals.length})
            </h3>
            {planView.goals.length === 0 ? (
              <EmptyState>No goals linked to this plan.</EmptyState>
            ) : (
              <ul
                className="surface divide-border divide-y overflow-hidden text-sm"
                data-testid="goals-list"
              >
                {planView.goals.map((goal) => (
                  <li
                    key={goal.id}
                    className="flex items-center justify-between p-4"
                    data-testid="goal-item"
                  >
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
