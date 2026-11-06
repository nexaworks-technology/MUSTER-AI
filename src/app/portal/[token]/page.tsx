import type { Metadata } from "next";
import { noteAuthFailure, openTokenPage, TOO_MANY } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";
import { getPortalView, PortalAuthError } from "@/modules/portal/service";

export const metadata: Metadata = { title: "Customer Portal" };

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
      <main className="mx-auto max-w-xl p-8">
        <div className="rounded-md border p-6 text-center" data-testid="portal-auth-error">
          <h1 className="text-xl font-semibold">Portal Access</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {authError ?? "Unable to load portal."}
          </p>
        </div>
      </main>
    );
  }

  const { account, contact, successPlans, qbrDocuments } = portalData;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6" data-testid="portal-container">
      <header className="border-b pb-4">
        <h1 className="text-2xl font-bold">{account.name} Portal</h1>
        <p className="text-muted-foreground text-sm">
          Welcome back, {contact.name ?? contact.email}
        </p>
      </header>

      <section aria-labelledby="plans-heading" className="space-y-3">
        <h2 id="plans-heading" className="text-lg font-semibold">
          Shared Success Plans
        </h2>
        {successPlans.length === 0 ? (
          <p className="text-muted-foreground text-sm">No shared plans at this time.</p>
        ) : (
          <div className="space-y-4">
            {successPlans.map((plan) => (
              <div key={plan.id} className="rounded-md border p-4" data-testid="portal-plan">
                <h3 className="font-medium">{plan.title}</h3>
                <span className="text-muted-foreground text-xs uppercase">{plan.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="qbr-heading" className="space-y-3">
        <h2 id="qbr-heading" className="text-lg font-semibold">
          Business Reviews & Reports
        </h2>
        {qbrDocuments.length === 0 ? (
          <p className="text-muted-foreground text-sm">No reports shared yet.</p>
        ) : (
          <div className="space-y-3">
            {qbrDocuments.map((doc) => (
              <div key={doc.id} className="rounded-md border p-4" data-testid="portal-doc">
                <h3 className="font-medium">{doc.title}</h3>
                <p className="text-muted-foreground text-xs">
                  Published on {doc.lockedAt?.toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
