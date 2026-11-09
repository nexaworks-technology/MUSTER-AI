import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Globe } from "lucide-react";
import { getInitials } from "@/components/app/data-list";
import { DisagreementMark, RiskBadge } from "@/components/app/risk-badge";
import { StatusPill } from "@/components/app/status-pill";
import { STAGE_LABELS, TIER_LABELS } from "@/modules/accounts/schemas";
import { healthForAccounts } from "@/modules/health/service";
import { loadAccount } from "./data";
import { TabNav } from "./tab-nav";

/** Account 360 (spec §5). Tabs appear only for data that exists in this milestone. */
export default async function AccountLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const healthMap = await healthForAccounts(ctx, [account.id]);
  const health = healthMap.get(account.id);

  const base = `/accounts/${account.id}`;
  const tabs = [
    { label: "Overview", href: base },
    { label: "Health", href: `${base}/health` },
    { label: "Onboarding", href: `${base}/onboarding` },
    { label: "Renewal", href: `${base}/renewal` },
    { label: "Expansion", href: `${base}/expansion` },
    { label: "Signals", href: `${base}/signals` },
    { label: "Outcomes", href: `${base}/outcomes` },
    { label: "People", href: `${base}/people` },
    { label: "Usage", href: `${base}/usage` },
    { label: "Adoption", href: `${base}/adoption` },
    { label: "Tickets", href: `${base}/tickets` },
    { label: "Conversations", href: `${base}/conversations` },
    { label: "Promises", href: `${base}/promises` },
    { label: "Contracts & billing", href: `${base}/billing` },
    { label: "Plans", href: `${base}/plans` },
    { label: "Tasks", href: `${base}/tasks` },
    { label: "Notes", href: `${base}/notes` },
    { label: "Timeline", href: `${base}/timeline` },
  ] as Array<{ label: string; href: Route }>;

  return (
    <div className="space-y-section">
      <div className="space-y-3">
        {/* Back Link */}
        <div>
          <Link
            href="/accounts"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            <span>Accounts</span>
          </Link>
        </div>

        {/* R3: Premium Header */}
        <div className="surface rounded-2xl border border-border/80 p-5 sm:p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="flex items-start gap-4 min-w-0">
            {/* Account Monogram Tile */}
            <div className="size-14 rounded-2xl bg-primary/10 border border-primary/20 text-primary font-bold text-lg flex items-center justify-center shrink-0 shadow-2xs">
              {getInitials(account.name)}
            </div>

            {/* Account Name and Badges */}
            <div className="space-y-2 min-w-0">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground truncate">
                  {account.name}
                </h1>
                {account.domain ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                    <Globe className="size-3 text-muted-foreground/70" />
                    <span>{account.domain}</span>
                  </div>
                ) : null}
              </div>

              {/* Status & Metadata Pills */}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <StatusPill variant="neutral" size="sm">
                  {TIER_LABELS[account.tier]}
                </StatusPill>
                <StatusPill variant="neutral" size="sm">
                  {STAGE_LABELS[account.lifecycleStage]}
                </StatusPill>
                <StatusPill variant="neutral" size="sm">
                  {account.ownerName ? `Owner: ${account.ownerName}` : "No owner"}
                </StatusPill>
                {account.plan ? (
                  <StatusPill variant="primary" size="sm">
                    {account.plan}
                  </StatusPill>
                ) : null}
              </div>
            </div>
          </div>

          {/* R3: Health Score Widget with Ring & Band Pill */}
          <div className="flex items-center gap-3.5 bg-muted/40 rounded-xl border border-border/60 p-3 self-start md:self-center shrink-0">
            {health?.riskLevel ? (
              <>
                <div className="relative size-12 shrink-0 flex items-center justify-center">
                  <svg className="size-12 -rotate-90 transform" viewBox="0 0 36 36">
                    <path
                      className="text-muted/60"
                      strokeWidth="3.5"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    <path
                      className={
                        health.riskLevel === "HEALTHY"
                          ? "text-risk-healthy"
                          : health.riskLevel === "WATCH"
                            ? "text-risk-watch"
                            : health.riskLevel === "AT_RISK"
                              ? "text-risk-at-risk"
                              : "text-muted-foreground"
                      }
                      strokeDasharray={`${health.overall ?? 0}, 100`}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                  </svg>
                  <span className="absolute font-bold text-sm tabular-nums text-foreground">
                    {health.overall === null ? "—" : health.overall.toFixed(0)}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <RiskBadge level={health.riskLevel} />
                    {health.pulseDisagreement ? <DisagreementMark /> : null}
                  </div>
                  <span className="text-[11px] text-muted-foreground block font-medium">
                    Health score
                  </span>
                </div>
              </>
            ) : (
              <div className="px-1 py-0.5">
                <StatusPill variant="neutral">Not scored yet</StatusPill>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* R3: Restyled Tabs */}
      <TabNav tabs={tabs} />

      {children}
    </div>
  );
}
