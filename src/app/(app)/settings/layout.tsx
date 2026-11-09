import type { ReactNode } from "react";
import { allowedSettingsTabs, requireSettingsAccess } from "./access";
import { SettingsTabNav } from "./tab-nav";

/** Settings shows only the tabs a member may use; with none, it does not exist (404). */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ctx = await requireSettingsAccess();
  return (
    <div className="space-y-section">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <SettingsTabNav tabs={allowedSettingsTabs(ctx)} />
      </div>
      {children}
    </div>
  );
}
