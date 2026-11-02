import type { Metadata } from "next";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { CURRENCY_OPTIONS, TIMEZONE_OPTIONS } from "@/modules/settings/schemas";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Workspace" };

export default async function WorkspaceSettingsPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  return (
    <WorkspaceForm
      name={ctx.workspace.name}
      timezone={ctx.workspace.timezone}
      baseCurrency={ctx.workspace.baseCurrency}
      timezones={TIMEZONE_OPTIONS}
      currencies={CURRENCY_OPTIONS}
    />
  );
}
