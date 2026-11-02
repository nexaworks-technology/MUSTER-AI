import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/app/native-select";
import { PRODUCT_NAME } from "@/config/product";
import { visibleNav } from "@/config/features";
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
  return (
    <div className="min-h-screen md:grid md:grid-cols-[13rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:p-2">
        Skip to content
      </a>
      <aside className="border-border bg-muted border-b md:min-h-screen md:border-r md:border-b-0">
        <div className="px-4 py-3 text-sm font-semibold">{PRODUCT_NAME}</div>
        <nav aria-label="Main" className="overflow-x-auto px-2 pb-2">
          <ul className="flex gap-1 md:flex-col">
            {nav.map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  className="hover:bg-accent focus-visible:ring-ring/50 block rounded-md px-3 py-1.5 text-sm whitespace-nowrap focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
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
            <span className="text-sm font-medium">{ctx.workspace.name}</span>
          )}
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <span>{userLabel}</span>
            {signOut}
          </div>
        </header>
        <main id="main" className="px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
