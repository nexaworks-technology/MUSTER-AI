import type { Metadata } from "next";
import { FileText, LinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { noteAuthFailure, openTokenPage, TOO_MANY } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";
import { getPortalView, PortalAuthError } from "@/modules/portal/service";

export const metadata: Metadata = { title: "Customer Portal" };

const PLAN_STATUS_VARIANT: Record<string, "neutral" | "accent" | "success"> = {
  ACTIVE: "success",
  COMPLETED: "accent",
};

export default async function CustomerPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let portalData;
  let authError: string | null = null;
  // M12 A9: limited per IP; a bad token counts against the IP (repeated failures block it).
  const gate = await openTokenPage("portal", LIMITS.portalPerIp);
  if (gate.refused) authError = TOO_MANY;
  else
    try {
      portalData = await getPortalView(token);
    } catch (err) {
      if (err instanceof PortalAuthError) await noteAuthFailure(gate.ip);
      authError =
        err instanceof PortalAuthError ? err.message : "Portal access link is invalid or expired.";
    }

  if (authError || !portalData) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10 md:py-16">
        <Card
          className="w-full items-center gap-3 px-6 py-10 text-center md:px-10 md:py-12"
          data-testid="portal-auth-error"
        >
          <span
            className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full"
            aria-hidden="true"
          >
            <LinkIcon className="size-5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Portal Access</h1>
          <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
            {authError ?? "Unable to load portal."}
          </p>
        </Card>
      </main>
    );
  }

  const { account, contact, successPlans, qbrDocuments } = portalData;

  return (
    <main
      className="mx-auto max-w-2xl space-y-8 px-4 py-8 md:space-y-10 md:py-14"
      data-testid="portal-container"
    >
      <header className="border-b pb-6">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{account.name} Portal</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Welcome back, {contact.name ?? contact.email}
        </p>
      </header>

      <section aria-labelledby="plans-heading" className="space-y-4">
        <h2 id="plans-heading" className="text-lg font-semibold tracking-tight">
          Shared Success Plans
        </h2>
        {successPlans.length === 0 ? (
          <Card className="px-5 py-6">
            <p className="text-muted-foreground text-sm">No shared plans at this time.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {successPlans.map((plan) => (
              <Card
                key={plan.id}
                className="flex-col items-start gap-2 px-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                data-testid="portal-plan"
              >
                <h3 className="font-medium">{plan.title}</h3>
                <Badge variant={PLAN_STATUS_VARIANT[plan.status] ?? "neutral"}>
                  <span className="tracking-wide uppercase">{plan.status}</span>
                </Badge>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="qbr-heading" className="space-y-4">
        <h2 id="qbr-heading" className="text-lg font-semibold tracking-tight">
          Business Reviews & Reports
        </h2>
        {qbrDocuments.length === 0 ? (
          <Card className="px-5 py-6">
            <p className="text-muted-foreground text-sm">No reports shared yet.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {qbrDocuments.map((doc) => (
              <Card
                key={doc.id}
                className="flex-row items-start gap-3 px-5"
                data-testid="portal-doc"
              >
                <span
                  className="bg-accent text-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-md"
                  aria-hidden="true"
                >
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium">{doc.title}</h3>
                  <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                    Published on {doc.lockedAt?.toLocaleDateString()}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
