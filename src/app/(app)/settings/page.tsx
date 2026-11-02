import { redirect } from "next/navigation";
import { allowedSettingsTabs, requireSettingsAccess } from "./access";

/** /settings opens the first tab this member may use. */
export default async function SettingsIndex() {
  const ctx = await requireSettingsAccess();
  redirect(allowedSettingsTabs(ctx)[0]!.href);
}
