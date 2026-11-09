"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

const ROUTE_LABELS: Record<string, string> = {
  "": "Home",
  today: "Today",
  approvals: "Approvals",
  tasks: "Tasks",
  accounts: "Accounts",
  health: "Health",
  onboarding: "Onboarding",
  renewals: "Renewals",
  expansion: "Expansion",
  plays: "Plays",
  inbox: "Inbox",
  promises: "Promises",
  revenue: "Revenue",
  reports: "Reports",
  ask: "Ask AI",
  settings: "Settings",
  notifications: "Notifications",
};

export function TopBarBreadcrumb({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname() || "/";
  const segments = pathname.split("/").filter(Boolean);

  let currentLabel = "Home";
  const rootSegment = segments[0];
  if (rootSegment) {
    currentLabel =
      ROUTE_LABELS[rootSegment] ?? rootSegment.charAt(0).toUpperCase() + rootSegment.slice(1);
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
    >
      <Link
        href="/"
        className="hover:text-foreground text-foreground font-medium transition-colors"
      >
        {workspaceName}
      </Link>
      {segments.length > 0 ? (
        <>
          <ChevronRight aria-hidden="true" className="text-muted-foreground/60 size-3.5 shrink-0" />
          <span className="text-foreground font-semibold tracking-tight" aria-current="page">
            {currentLabel}
          </span>
        </>
      ) : null}
    </nav>
  );
}
