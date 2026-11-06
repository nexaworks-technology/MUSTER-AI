import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AiText } from "@/components/app/ai-text";
import { AskBox } from "@/components/app/ask-box";
import { isAiConfigured } from "@/lib/ai";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { AskThreadNotFoundError, loadThreadView } from "@/modules/ask-ai/service";
import { VOICE_DICTATION_DISCLOSURE } from "@/modules/settings/schemas";
import { getSettingsData } from "@/modules/settings/service";
import { ASK_ACCEPT } from "../accept";
import { ApprovalCard } from "../approval-card";

/** One of your Ask AI conversations. Someone else's thread is a 404. */
export default async function AskThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const view = await loadThreadView(ctx, threadId).catch((e: unknown) => {
    if (e instanceof AskThreadNotFoundError) notFound();
    throw e;
  });
  const settings = await getSettingsData(ctx.workspaceId);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{view.thread.title}</h1>
      {!isAiConfigured() ? (
        <p
          role="status"
          className="border-warning/30 bg-warning-soft text-warning-soft-foreground rounded-lg border px-4 py-3 text-sm"
          data-testid="not-configured"
        >
          Ask AI is not set up (no AI provider configured), so questions here are saved but not
          answered.
        </p>
      ) : null}
      {view.files.length ? (
        <ul className="text-muted-foreground text-sm" aria-label="Attached files">
          {view.files.map((f) => (
            <li key={f.id}>
              {f.name}
              {f.scanned ? "" : " (waiting for the malware scan, not readable yet)"}
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="space-y-4" data-testid="ask-messages">
        {view.messages.map((m) => (
          <li key={m.id} className="space-y-2" data-role={m.role}>
            {m.role === "USER" ? (
              <p className="bg-secondary text-secondary-foreground rounded-lg px-4 py-3 text-sm whitespace-pre-wrap">
                {m.content}
              </p>
            ) : m.run?.status === "SUCCEEDED" ? (
              <>
                <div className="surface p-4">
                  <AiText
                    run={m.run}
                    items={[
                      {
                        text: m.content,
                        sources: m.citations.map((c) => ({
                          label: c.label,
                          href: c.href,
                          missing: false,
                        })),
                      },
                    ]}
                  />
                </div>
                {m.cards.map((c) => (
                  <ApprovalCard key={c.id} card={c} />
                ))}
              </>
            ) : (
              <p
                className="bg-card border-border rounded-lg border px-4 py-3 text-sm"
                data-testid="no-answer"
              >
                I could not answer that with sources I can show you.
                {m.run ? (
                  <>
                    {" "}
                    <Link
                      href={`/agent-runs/${m.run.id}` as Route}
                      className="text-primary underline underline-offset-2"
                    >
                      What it read
                    </Link>
                  </>
                ) : null}
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="surface p-4">
        <AskBox
          threadId={view.thread.id}
          voiceEnabled={settings.ask.voiceDictation}
          disclosure={VOICE_DICTATION_DISCLOSURE}
          accept={ASK_ACCEPT}
        />
      </div>
    </>
  );
}
