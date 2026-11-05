import type { Route } from "next";
import { can, type MemberAccess, type Permission } from "@/lib/auth/permissions";

/**
 * Navigation, in the spec's words (spec §5). An item appears only once the milestone that
 * builds its screen has shipped; until then it is hidden and its URL is a normal 404 (Rule 6 —
 * no placeholder screens). Bump SHIPPED_MILESTONE and set `href` when a screen lands.
 */
export const SHIPPED_MILESTONE = 10;

export interface NavItem {
  label: string;
  href: Route | null;
  milestone: number;
  permission?: Permission;
  /** Shown when the member has at least one of these. */
  anyPermission?: readonly Permission[];
}

export const NAV: readonly NavItem[] = [
  { label: "Home", href: "/", milestone: 1 },
  { label: "Today", href: "/today", milestone: 4 },
  { label: "Approvals", href: "/approvals", milestone: 4, permission: "approvals:decide" },
  { label: "Accounts", href: "/accounts", milestone: 2 },
  { label: "Tasks", href: "/tasks", milestone: 2 },
  { label: "Health", href: "/health", milestone: 3 },
  { label: "Onboarding", href: "/onboarding", milestone: 6 },
  { label: "Renewals", href: "/renewals", milestone: 7 },
  { label: "Expansion", href: "/expansion", milestone: 7 },
  { label: "Plays", href: "/plays", milestone: 8 },
  { label: "Inbox", href: "/inbox", milestone: 9 },
  { label: "Promises", href: "/promises", milestone: 9 },
  { label: "Meetings & QBRs", href: null, milestone: 10 },
  { label: "Success Plans", href: null, milestone: 10 },
  { label: "Revenue", href: "/revenue", milestone: 7, permission: "revenue:view" },
  { label: "Reports", href: null, milestone: 11 },
  { label: "Ask AI", href: null, milestone: 11 },
  { label: "Customers", href: null, milestone: 10 },
  {
    label: "Settings",
    href: "/settings",
    milestone: 1,
    anyPermission: ["workspace:manageUsers", "workspace:manageSettings", "data:import"],
  },
];

export function visibleNav(
  member: MemberAccess,
  shipped = SHIPPED_MILESTONE,
): Array<NavItem & { href: Route }> {
  return NAV.filter(
    (item): item is NavItem & { href: Route } =>
      item.milestone <= shipped &&
      item.href !== null &&
      (!item.permission || can(member, item.permission) !== null) &&
      (!item.anyPermission || item.anyPermission.some((p) => can(member, p) !== null)),
  );
}
