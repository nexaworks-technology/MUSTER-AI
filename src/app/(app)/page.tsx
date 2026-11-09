import { DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { BOOK_SCOPE_LABELS, ROLE_LABELS } from "@/modules/settings/schemas";

export default async function HomePage() {
  // The layout already handled the signed-out and no-workspace cases.
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) return null;
  return (
    <div className="space-y-section max-w-2xl">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center justify-center text-base shadow-xs shrink-0">
          {ctx.workspace.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{ctx.workspace.name}</h1>
          <p className="text-muted-foreground text-xs">Customer success command center</p>
        </div>
      </div>

      <DataListCard className="p-5 space-y-4">
        <div className="border-b border-border/60 pb-3">
          <h2 className="text-base font-semibold">Your access</h2>
          <p className="text-muted-foreground text-xs mt-0.5">Permissions and scope for this workspace</p>
        </div>
        <dl className="divide-border divide-y text-sm">
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Signed in as</dt>
            <dd className="text-xs font-medium text-foreground">{ctx.user.name ? `${ctx.user.name} (${ctx.user.email})` : ctx.user.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Role</dt>
            <dd data-testid="role">
              <StatusPill variant="primary" size="sm">
                {ROLE_LABELS[ctx.role]}
              </StatusPill>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Accounts you see</dt>
            <dd className="text-xs text-foreground font-medium">{BOOK_SCOPE_LABELS[ctx.bookScope]}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Revenue access</dt>
            <dd>
              <StatusPill variant={ctx.canViewRevenue ? "success" : "neutral"} size="sm" withDot={false}>
                {ctx.canViewRevenue ? "Yes" : "No"}
              </StatusPill>
            </dd>
          </div>
        </dl>
      </DataListCard>

      <DataListCard className="p-5 space-y-4">
        <div className="border-b border-border/60 pb-3">
          <h2 className="text-base font-semibold">Workspace</h2>
          <p className="text-muted-foreground text-xs mt-0.5">Global regional settings and currency</p>
        </div>
        <dl className="divide-border divide-y text-sm">
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Time zone</dt>
            <dd className="text-xs font-medium text-foreground tabular-nums">{ctx.workspace.timezone}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground text-xs font-medium w-36 shrink-0">Base currency</dt>
            <dd className="text-xs font-medium text-foreground">
              <span className="font-mono">{ctx.workspace.baseCurrency}</span>
            </dd>
          </div>
        </dl>
      </DataListCard>
    </div>
  );
}
