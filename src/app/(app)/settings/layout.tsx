import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";

/** Settings is admin-only; for everyone else it does not exist (404), matching the hidden nav. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "workspace:manageUsers")) notFound();
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <nav aria-label="Settings">
          <ul className="border-border flex gap-4 border-b text-sm">
            <li>
              <Link href="/settings/users" className="inline-block py-2 hover:underline">
                Users
              </Link>
            </li>
            <li>
              <Link href="/settings/workspace" className="inline-block py-2 hover:underline">
                Workspace
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      {children}
    </div>
  );
}
