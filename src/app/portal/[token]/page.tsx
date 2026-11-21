import type { Metadata } from "next";
import { FileText, LinkIcon } from "lucide-react";
import { StatusPill } from "@/components/app/status-pill";
import { noteAuthFailure, openTokenPage, TOO_MANY } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";
import { getPortalView, PortalAuthError } from "@/modules/portal/service";
import { MusterLockup } from "@/components/brand/muster-mark";

export const metadata: Metadata = { title: "Customer Portal" };

const GOAL_WORDS: Record<string, string> = {
  OPEN: "In progress",
  ACHIEVED: "Achieved",
  MISSED: "Missed",
  DROPPED: "Dropped",
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
        <div
          className="surface-card rounded-2xl border border-border/80 w-full flex flex-col items-center gap-3 px-6 py-10 text-center md:px-10 md:py-12 shadow-sm"
          data-testid="portal-auth-error"
        >
          <span
            className="bg-muted/80 text-muted-foreground flex size-12 items-center justify-center rounded-xl border border-border/60"
            aria-hidden="true"
          >
            <LinkIcon className="size-5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Portal Access</h1>
          <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
            {authError ?? "Unable to load portal."}
          </p>
        </div>
      </main>
    );
  }

  const { account, contact, successPlans, qbrDocuments } = portalData;

  return (
    <main
      className="mx-auto max-w-2xl space-y-8 px-4 py-8 md:space-y-10 md:py-14"
      data-testid="portal-container"
    >
      <header className="border-b border-border/80 pb-6">
        <MusterLockup size="sm" className="mb-5" />
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl text-foreground">{account.name} Portal</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Welcome back, {contact.name ?? contact.email}
        </p>
      </header>

      <section aria-labelledby="plans-heading" className="space-y-4">
        <h2 id="plans-heading" className="text-lg font-semibold tracking-tight">
          Shared Success Plans
        </h2>
        {successPlans.length === 0 ? (
          <div className="surface-card rounded-xl border border-border/80 px-5 py-6 shadow-xs">
            <p className="text-muted-foreground text-sm">No shared plans at this time.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {successPlans.map((plan) => (
              <div
                key={plan.id}
                className="surface-card rounded-xl border border-border/80 p-5 shadow-xs hover:shadow-sm transition-all"
                data-testid="portal-plan"
              >
                <div className="w-full space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-medium text-foreground">{plan.title}</h3>
                    <StatusPill variant={plan.status === "ACTIVE" ? "success" : "accent"} size="sm">
                      <span className="tracking-wide uppercase text-[10px]">{plan.status}</span>
                    </StatusPill>
                  </div>
                  {plan.goals.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No goals on this plan yet.</p>
                  ) : (
                    <ul className="space-y-1 text-sm" aria-label={`Goals of ${plan.title}`}>
                      {plan.goals.map((g) => (
                        <li key={g.id} className="flex items-center justify-between gap-3" data-testid="portal-goal">
                          <span>{g.text}</span>
                          <span className="text-muted-foreground text-xs">{GOAL_WORDS[g.status]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="qbr-heading" className="space-y-4">
        <h2 id="qbr-heading" className="text-lg font-semibold tracking-tight">
          Business Reviews & Reports
        </h2>
        {qbrDocuments.length === 0 ? (
          <div className="surface-card rounded-xl border border-border/80 px-5 py-6 shadow-xs">
            <p className="text-muted-foreground text-sm">No reports shared yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {qbrDocuments.map((doc) => (
              <div
                key={doc.id}
                className="surface-card rounded-xl border border-border/80 flex flex-row items-start gap-3.5 p-5 shadow-xs hover:shadow-sm transition-all"
                data-testid="portal-doc"
              >
                <span
                  className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20"
                  aria-hidden="true"
                >
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium text-foreground">{doc.title}</h3>
                  <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                    Published on {doc.lockedAt?.toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
