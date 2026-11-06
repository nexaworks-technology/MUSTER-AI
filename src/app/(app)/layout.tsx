import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/app/native-select";
import { PRODUCT_NAME } from "@/config/product";
import { visibleNav } from "@/config/features";
import { unreadCount } from "@/modules/notifications/service";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { signOutAction } from "../sign-in/actions";
import { switchWorkspaceAction } from "./actions";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const ctx = await resolveWorkspaceContext(session);
  const userLabel = session.user.name ?? session.user.email;

  const signOut = (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
    </form>
  );

  if (!ctx) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-4 py-16">
        <h1 className="text-xl font-semibold">{PRODUCT_NAME}</h1>
        <p>
          You&apos;re signed in as {userLabel}, but you aren&apos;t an active member of any
          workspace. Ask an admin of your workspace to invite you.
        </p>
        {signOut}
      </main>
    );
  }

  const nav = visibleNav(ctx);
  const unread = await unreadCount(ctx);
  return (
    <div className="min-h-screen md:flex">
      <a
        href="#main"
        className="bg-card text-foreground focus-visible:ring-ring sr-only z-50 rounded-md shadow-md focus:not-sr-only focus:absolute focus:m-2 focus:p-2 focus-visible:ring-2"
      >
        Skip to content
      </a>
      <aside className="border-border bg-muted border-b md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0">
        <div className="text-foreground flex items-center gap-2 px-5 py-4 text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="bg-primary size-2.5 shrink-0 rounded-full" />
          {PRODUCT_NAME}
        </div>
        <nav aria-label="Main" className="overflow-x-auto px-3 pb-3">
          <ul className="flex gap-1 md:flex-col">
            {nav.map((item) => (
              <li key={item.label}>
                <Link
                  // A UrlObject: with this many typed routes, passing the whole `Route` union to
                  // `href` crashes the TypeScript compiler (internal assertion), so the nav links by path.
                  href={{ pathname: item.href }}
                  className="text-foreground hover:bg-hover focus-visible:ring-ring block rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="border-border bg-card px-page flex flex-wrap items-center justify-between gap-2 border-b py-2.5">
          {ctx.workspaces.length > 1 ? (
            <form action={switchWorkspaceAction} className="flex items-center gap-2">
              <label htmlFor="workspace-switch" className="sr-only">
                Workspace
              </label>
              <NativeSelect id="workspace-switch" name="workspaceId" defaultValue={ctx.workspaceId}>
                {ctx.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
              <Button type="submit" variant="outline" size="sm">
                Switch
              </Button>
            </form>
          ) : (
            <span className="text-foreground text-sm font-semibold">{ctx.workspace.name}</span>
          )}
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Link
              href="/notifications"
              className="hover:bg-hover focus-visible:ring-ring rounded-md px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            >
              <span aria-hidden="true">🔔</span>
              {unread > 0 ? (
                <span
                  className="bg-primary text-primary-foreground ml-1 rounded-full px-1.5 py-0.5 text-xs font-medium"
                  data-testid="unread-count"
                >
                  {unread}
                </span>
              ) : null}
            </Link>
            <span>{userLabel}</span>
            {signOut}
          </div>
        </header>
        <main id="main" className="px-page py-section">
          <div className="max-w-content mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
