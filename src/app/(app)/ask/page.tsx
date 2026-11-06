import { AskBox } from "@/components/app/ask-box";
import { ASK_ACCEPT } from "./accept";
import { isAiConfigured } from "@/lib/ai";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { VOICE_DICTATION_DISCLOSURE } from "@/modules/settings/schemas";
import { getSettingsData } from "@/modules/settings/service";

/** A new Ask AI conversation. */
export default async function AskPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const settings = await getSettingsData(ctx.workspaceId);
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Ask AI</h1>
        <p className="text-muted-foreground text-sm">
          Answers come only from records you can already see, each with its sources. Ask AI can
          propose changes, but nothing happens until a person approves it.
        </p>
      </div>
      {!isAiConfigured() ? (
        <p
          role="status"
          className="border-warning/30 bg-warning-soft text-warning-soft-foreground rounded-lg border px-4 py-3 text-sm"
          data-testid="not-configured"
        >
          Ask AI is not set up (no AI provider configured). Your question will be saved, but nothing
          can answer it until an Admin configures one.
        </p>
      ) : null}
      <div className="surface p-4">
        <AskBox
          voiceEnabled={settings.ask.voiceDictation}
          disclosure={VOICE_DICTATION_DISCLOSURE}
          accept={ASK_ACCEPT}
        />
      </div>
    </>
  );
}
