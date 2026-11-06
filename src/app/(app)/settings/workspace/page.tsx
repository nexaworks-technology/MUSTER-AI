import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import {
  CURRENCY_OPTIONS,
  TIMEZONE_OPTIONS,
  VOICE_DICTATION_DISCLOSURE,
} from "@/modules/settings/schemas";
import { getSettingsData } from "@/modules/settings/service";
import { requireSettingsAccess } from "../access";
import { VoiceDictationForm, WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Workspace" };

export default async function WorkspaceSettingsPage() {
  const ctx = await requireSettingsAccess("workspace:manageSettings");
  const settings = await getSettingsData(ctx.workspaceId);
  return (
    <div className="space-y-section">
      <Card className="max-w-lg">
        <CardContent>
          <WorkspaceForm
            name={ctx.workspace.name}
            timezone={ctx.workspace.timezone}
            baseCurrency={ctx.workspace.baseCurrency}
            timezones={TIMEZONE_OPTIONS}
            currencies={CURRENCY_OPTIONS}
          />
        </CardContent>
      </Card>
      <Card className="max-w-lg">
        <CardContent>
          <VoiceDictationForm
            enabled={settings.ask.voiceDictation}
            disclosure={VOICE_DICTATION_DISCLOSURE}
          />
        </CardContent>
      </Card>
    </div>
  );
}
