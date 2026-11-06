import Link from "next/link";
import type { ReactNode } from "react";
import { allowedSettingsTabs, requireSettingsAccess } from "./access";

/** Settings shows only the tabs a member may use; with none, it does not exist (404). */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSettingsAccess();
  return (
    <div className="space-y-section">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <nav aria-label="Settings" className="border-border overflow-x-auto border-b">
          <ul className="flex gap-1 text-sm">
            {allowedSettingsTabs(ctx).map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className="focus-visible:ring-ring text-foreground hover:border-border inline-block rounded-t-md border-b-2 border-transparent px-3 py-2.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {children}
    </div>
  );
}
