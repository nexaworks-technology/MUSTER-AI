import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IssuePortalLink } from "@/components/portal/issue-link";
import { formatDate } from "@/lib/format";
import { listPeople } from "@/modules/contacts/service";
import { listPortalLinks } from "@/modules/portal/service";
import { revokePortalLinkAction } from "@/modules/portal/actions/links";
import { getAccountSuccessPlan } from "@/modules/success-plans/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Success Plans" };

export default async function AccountPlansPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const [planView, links, people] = await Promise.all([
    getAccountSuccessPlan(ctx, account.id),
    listPortalLinks(ctx, account.id),
    account.canEdit ? listPeople(ctx, account.id) : Promise.resolve([]),
  ]);
  const tz = ctx.workspace.timezone;

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
              <span className="text-foreground font-medium" data-testid="plan-progress">
                {planView.progressPercent}%
              </span>
              <span className="ml-1 text-xs" data-testid="plan-progress-basis">
                ({basisText(planView.progressBasis)})
              </span>
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

      <section aria-labelledby="portal-heading" className="surface space-y-4 p-5" data-testid="portal-access">
        <div>
          <h3 id="portal-heading" className="text-base font-semibold">
            Customer portal
          </h3>
          <p className="text-muted-foreground text-sm">
            A portal link lets one contact see the plans shared with the portal and locked business
            reviews. It expires after 14 days and can be revoked here.
          </p>
        </div>
        {account.canEdit ? (
          <IssuePortalLink
            accountId={account.id}
            contacts={people
              .filter((p) => p.status === "ACTIVE")
              .map((p) => ({ id: p.id, name: p.name, email: p.email }))}
          />
        ) : null}
        {links.length === 0 ? (
          <p className="text-muted-foreground text-sm">No portal links yet.</p>
        ) : (
          <ul className="divide-border divide-y text-sm" data-testid="portal-links">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {l.contactName}
                  {l.contactEmail ? ` (${l.contactEmail})` : ""} · created {formatDate(l.createdAt, tz)} ·{" "}
                  {l.revokedAt
                    ? `revoked ${formatDate(l.revokedAt, tz)}`
                    : l.active
                      ? `active until ${formatDate(l.expiresAt, tz)}`
                      : `expired ${formatDate(l.expiresAt, tz)}`}
                  {l.lastUsedAt ? ` · last opened ${formatDate(l.lastUsedAt, tz)}` : " · not opened yet"}
                </span>
                {l.active && account.canEdit ? (
                  <form action={revokePortalLinkAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <input type="hidden" name="portalAccessId" value={l.id} />
                    <Button type="submit" size="xs" variant="outline">
                      Revoke
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function basisText(b: { milestones: number; milestonesDone: number; goals: number; goalsAchieved: number }) {
  const parts = [
    b.goals ? `${b.goalsAchieved} of ${b.goals} goal${b.goals === 1 ? "" : "s"} achieved` : null,
    b.milestones
      ? `${b.milestonesDone} of ${b.milestones} milestone${b.milestones === 1 ? "" : "s"} done`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no goals or milestones yet";
}
