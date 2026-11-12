import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AiText } from "@/components/app/ai-text";
import { StarburstMark } from "@/components/app/starburst";
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
      <h1 className="text-xl font-medium tracking-tight">{view.thread.title}</h1>
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
      <ol className="space-y-8" data-testid="ask-messages">
        {view.messages.map((m) => (
          <li key={m.id} className="space-y-2" data-role={m.role}>
            {m.role === "USER" ? (
              <div className="flex justify-end">
                <p className="bg-ask-bubble text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
                  {m.content}
                </p>
              </div>
            ) : m.run?.status === "SUCCEEDED" ? (
              <div className="space-y-4">
                <AiText
                  variant="document"
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
                {m.cards.map((c) => (
                  <ApprovalCard key={c.id} card={c} />
                ))}
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <StarburstMark className="text-muted-foreground mt-1 size-4 shrink-0" />
                <p className="text-muted-foreground text-sm leading-6" data-testid="no-answer">
                  {/* Stored for a run that did not produce an answer: always a plain system sentence
                      ("could not answer…", "took too long…"), never model text. */}
                  {m.content}
                  {m.run ? (
                    <>
                      {" "}
                      <Link
                        href={`/agent-runs/${m.run.id}` as Route}
                        className="text-ask-accent-text underline underline-offset-2"
                      >
                        What it read
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="from-ask-paper sticky bottom-0 mt-auto bg-gradient-to-t from-70% to-transparent pt-6 pb-4">
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
