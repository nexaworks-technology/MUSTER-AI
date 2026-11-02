import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { BOOK_SCOPE_LABELS, ROLE_LABELS } from "@/modules/settings/schemas";

export default async function HomePage() {
  // The layout already handled the signed-out and no-workspace cases.
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) return null;
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{ctx.workspace.name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Your access</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd>{ctx.user.name ? `${ctx.user.name} (${ctx.user.email})` : ctx.user.email}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd data-testid="role">{ROLE_LABELS[ctx.role]}</dd>
            <dt className="text-muted-foreground">Accounts you see</dt>
            <dd>{BOOK_SCOPE_LABELS[ctx.bookScope]}</dd>
            <dt className="text-muted-foreground">Revenue access</dt>
            <dd>{ctx.canViewRevenue ? "Yes" : "No"}</dd>
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
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Time zone</dt>
            <dd>{ctx.workspace.timezone}</dd>
            <dt className="text-muted-foreground">Base currency</dt>
            <dd>{ctx.workspace.baseCurrency}</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
