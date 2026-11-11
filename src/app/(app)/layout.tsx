import Link from "next/link";
import type { ReactNode } from "react";
import {
  Home,
  CalendarCheck,
  FileCheck,
  CheckSquare,
  Building2,
  Activity,
  Compass,
  RefreshCw,
  TrendingUp,
  CircleDollarSign,
  PlayCircle,
  Inbox,
  ShieldCheck,
  BarChart3,
  Sparkles,
  Video,
  Settings as SettingsIcon,
  Search,
  Bell,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavLink } from "@/components/app/nav-link";
import { NativeSelect } from "@/components/app/native-select";
import { TopBarBreadcrumb } from "@/components/app/breadcrumb";
import { getInitials } from "@/components/app/data-list";
import { cookies } from "next/headers";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { PRODUCT_NAME } from "@/config/product";
import { visibleNav } from "@/config/features";
import { unreadCount } from "@/modules/notifications/service";
import { ROLE_LABELS } from "@/modules/settings/schemas";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { signOutAction } from "../sign-in/actions";
import { switchWorkspaceAction } from "./actions";

const NAV_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Home,
  Today: CalendarCheck,
  Approvals: FileCheck,
  Tasks: CheckSquare,
  Accounts: Building2,
  Health: Activity,
  Onboarding: Compass,
  Renewals: RefreshCw,
  Expansion: TrendingUp,
  Revenue: CircleDollarSign,
  Plays: PlayCircle,
  Inbox,
  Promises: ShieldCheck,
  Reports: BarChart3,
  "Ask AI": Sparkles,
  "Meetings & QBRs": Video,
  Settings: SettingsIcon,
};

const NAV_GROUPS = [
  {
    title: "Work",
    items: ["Home", "Today", "Approvals", "Tasks", "Meetings & QBRs"],
  },
  {
    title: "Portfolio",
    items: ["Accounts", "Health", "Onboarding", "Renewals", "Expansion", "Revenue"],
  },
  {
    title: "Automation",
    items: ["Plays", "Inbox", "Promises"],
  },
  {
    title: "Insight",
    items: ["Reports", "Ask AI"],
  },
] as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const ctx = await resolveWorkspaceContext(session);
  const userLabel = session.user.name ?? session.user.email ?? "User";

  const signOut = (
    <form action={signOutAction}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
      >
        Sign out
      </Button>
    </form>
  );

  if (!ctx) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>
        <p className="text-muted-foreground text-sm">
          You&apos;re signed in as {userLabel}, but you aren&apos;t an active member of any
          workspace. Ask an admin of your workspace to invite you.
        </p>
        {signOut}
      </main>
    );
  }

  const nav = visibleNav(ctx);
  const visibleMap = new Map(nav.map((item) => [item.label, item]));
  const unread = await unreadCount(ctx);
  const settingsItem = visibleMap.get("Settings");
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <div className="min-h-screen md:flex">
      <a
        href="#main"
        className="bg-card text-foreground focus-visible:ring-ring sr-only z-50 rounded-md shadow-md focus:not-sr-only focus:absolute focus:m-2 focus:p-2 focus-visible:ring-2"
      >
        Skip to content
      </a>

      {/* S1: Sidebar */}
      <aside className="glass-chrome z-30 m-2 overflow-hidden rounded-2xl border md:sticky md:top-3 md:m-3 md:flex md:h-[calc(100vh-1.5rem)] md:w-60 md:shrink-0 md:flex-col">
        {/* Workspace Card at Top */}
        <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold shadow-xs">
              {ctx.workspace.name.charAt(0).toUpperCase()}
            </div>
            {ctx.workspaces.length > 1 ? (
              <form action={switchWorkspaceAction} className="flex min-w-0 items-center gap-1.5">
                <label htmlFor="workspace-switch" className="sr-only">
                  Workspace
                </label>
                <NativeSelect
                  id="workspace-switch"
                  name="workspaceId"
                  defaultValue={ctx.workspaceId}
                  className="h-7 py-0 text-xs font-medium"
                >
                  {ctx.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </NativeSelect>
                <Button type="submit" variant="outline" size="sm" className="h-7 px-2 text-xs">
                  Switch
                </Button>
              </form>
            ) : (
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-xs font-semibold tracking-tight">
                  {ctx.workspace.name}
                </div>
                <div className="text-muted-foreground truncate text-xs">{PRODUCT_NAME}</div>
              </div>
            )}
          </div>
        </div>

        {/* Grouped Navigation */}
        <nav
          aria-label="Main"
          className="flex-1 overflow-x-auto px-2 py-3 md:space-y-4 md:overflow-y-auto"
        >
          {/* Mobile horizontal scroll / desktop vertical grouped sections */}
          <div className="flex gap-1 md:flex-col md:gap-3">
            {NAV_GROUPS.map((group) => {
              const groupItems = group.items
                .map((name) => visibleMap.get(name))
                .filter((item): item is NonNullable<typeof item> => Boolean(item));

              if (groupItems.length === 0) return null;

              return (
                <div key={group.title} className="space-y-0.5">
                  <div className="text-muted-foreground hidden px-2.5 py-1 text-xs font-semibold tracking-wider uppercase md:block">
                    {group.title}
                  </div>
                  <ul className="flex gap-1 md:flex-col md:space-y-0.5">
                    {groupItems.map((item) => {
                      const Icon = NAV_ICONS[item.label] ?? Home;
                      return (
                        <li key={item.label}>
                          <NavLink
                            href={{ pathname: item.href }}
                            className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
                          >
                            <Icon className="size-4 shrink-0" />
                            <span>{item.label}</span>
                          </NavLink>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>

          {/* Settings pinned at bottom of navigation */}
          {settingsItem ? (
            <div className="border-border hidden border-t pt-2 md:block">
              <NavLink
                href={{ pathname: settingsItem.href }}
                className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <SettingsIcon className="size-4 shrink-0" />
                <span>Settings</span>
              </NavLink>
            </div>
          ) : null}
        </nav>

        {/* User Card at bottom of sidebar */}
        <div className="border-border hidden border-t px-3 py-3 md:flex md:items-center md:justify-between md:gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="border-border bg-accent text-accent-foreground flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
              {getInitials(userLabel)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-xs font-medium">{userLabel}</div>
              <div className="text-muted-foreground truncate text-[11px]">
                {ROLE_LABELS[ctx.role] ?? ctx.role}
              </div>
            </div>
          </div>
          <form action={signOutAction} className="shrink-0">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              title="Sign out"
              className="text-muted-foreground hover:text-foreground size-7 p-0"
            >
              <LogOut className="size-3.5" />
              <span className="sr-only">Sign out</span>
            </Button>
          </form>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar */}
        <header className="glass-chrome sticky top-2 z-20 mx-2 mt-0 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 md:top-3 md:mt-3 md:mr-3 md:ml-0">
          <div className="flex min-w-0 items-center gap-3">
            <TopBarBreadcrumb workspaceName={ctx.workspace.name} />
          </div>

          {/* Search field (visual shell with ⌘K hint) */}
          <div className="border-border/80 bg-muted/40 text-muted-foreground hover:border-border hidden w-64 max-w-xs cursor-default items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors select-none sm:flex">
            <Search className="text-muted-foreground/70 size-3.5 shrink-0" />
            <span className="flex-1 truncate">Search accounts, plays...</span>
            <kbd className="border-border bg-card text-muted-foreground inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] shadow-2xs">
              ⌘K
            </kbd>
          </div>

          {/* User actions and notifications */}
          <div className="flex items-center gap-2">
            <ThemeToggle initial={theme} />
            <Link
              href="/notifications"
              className="hover:bg-hover focus-visible:ring-ring text-muted-foreground hover:text-foreground relative flex items-center justify-center rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            >
              <Bell className="size-4" />
              {unread > 0 ? (
                <span
                  className="bg-primary text-primary-foreground absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full text-[10px] font-semibold"
                  data-testid="unread-count"
                >
                  {unread}
                </span>
              ) : null}
            </Link>
            <div className="border-border/60 flex items-center gap-2 border-l pl-2">
              <span className="text-foreground hidden text-xs font-medium md:inline">
                {userLabel}
              </span>
              {signOut}
            </div>
          </div>
        </header>

        <main id="main" className="px-page py-section flex-1">
          <div className="max-w-content mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
