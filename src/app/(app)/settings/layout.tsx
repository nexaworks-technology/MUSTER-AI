import Link from "next/link";
import type { ReactNode } from "react";
import { allowedSettingsTabs, requireSettingsAccess } from "./access";

/** Settings shows only the tabs a member may use; with none, it does not exist (404). */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSettingsAccess();
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <nav aria-label="Settings">
          <ul className="border-border flex gap-4 border-b text-sm">
            {allowedSettingsTabs(ctx).map((t) => (
              <li key={t.href}>
                <Link href={t.href} className="inline-block py-2 hover:underline">
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
