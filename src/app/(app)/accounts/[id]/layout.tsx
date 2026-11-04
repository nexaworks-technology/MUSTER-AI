import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { STAGE_LABELS, TIER_LABELS } from "@/modules/accounts/schemas";
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
  const { account } = await loadAccount(id);
  const base = `/accounts/${account.id}`;
  const tabs = [
    { label: "Overview", href: base },
    { label: "Health", href: `${base}/health` },
    { label: "Onboarding", href: `${base}/onboarding` },
    { label: "Renewal", href: `${base}/renewal` },
    { label: "Expansion", href: `${base}/expansion` },
    { label: "Signals", href: `${base}/signals` },
    { label: "People", href: `${base}/people` },
    { label: "Usage", href: `${base}/usage` },
    { label: "Adoption", href: `${base}/adoption` },
    { label: "Tickets", href: `${base}/tickets` },
    { label: "Conversations", href: `${base}/conversations` },
    { label: "Promises", href: `${base}/promises` },
    { label: "Contracts & billing", href: `${base}/billing` },
    { label: "Tasks", href: `${base}/tasks` },
    { label: "Notes", href: `${base}/notes` },
    { label: "Timeline", href: `${base}/timeline` },
  ] as Array<{ label: string; href: Route }>;
  return (
    <div className="space-y-4">
      <div>
        <Link href="/accounts" className="text-muted-foreground text-sm hover:underline">
          ← Accounts
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{account.name}</h1>
        <p className="text-muted-foreground text-sm">
          {TIER_LABELS[account.tier]} · {STAGE_LABELS[account.lifecycleStage]} ·{" "}
          {account.ownerName ? `Owner: ${account.ownerName}` : "No owner"}
        </p>
      </div>
      <TabNav tabs={tabs} />
      {children}
    </div>
  );
}
