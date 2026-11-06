import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { BOOK_SCOPE_LABELS, ROLE_LABELS } from "@/modules/settings/schemas";

export default async function HomePage() {
  // The layout already handled the signed-out and no-workspace cases.
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) return null;
  return (
    <div className="space-y-section max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{ctx.workspace.name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Your access</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-border divide-y text-sm">
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Signed in as</dt>
              <dd>{ctx.user.name ? `${ctx.user.name} (${ctx.user.email})` : ctx.user.email}</dd>
            </div>
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Role</dt>
              <dd data-testid="role">{ROLE_LABELS[ctx.role]}</dd>
            </div>
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Accounts you see</dt>
              <dd>{BOOK_SCOPE_LABELS[ctx.bookScope]}</dd>
            </div>
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Revenue access</dt>
              <dd>{ctx.canViewRevenue ? "Yes" : "No"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Workspace</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-border divide-y text-sm">
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Time zone</dt>
              <dd>{ctx.workspace.timezone}</dd>
            </div>
            <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground w-36 shrink-0">Base currency</dt>
              <dd>{ctx.workspace.baseCurrency}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
