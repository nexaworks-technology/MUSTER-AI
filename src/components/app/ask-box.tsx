"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { askAction, type AskActionState } from "@/modules/ask-ai/actions/ask";
import { browserHasSpeechRecognition, dictationOffered } from "@/modules/ask-ai/schemas";

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

/**
 * The Ask AI box: a question, optional file attachment, and (Q-11) browser dictation when the
 * Admin turned it on. Dictation only fills this text box; audio never reaches our servers.
 */
export function AskBox({
  threadId,
  voiceEnabled,
  disclosure,
  accept,
}: {
  threadId?: string;
  voiceEnabled: boolean;
  disclosure: string;
  accept: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<AskActionState, FormData>(askAction, {});
  const [text, setText] = useState("");
  // The browser capability is only known on the client; the server render assumes "no".
  const supported = useSyncExternalStore(
    () => () => {},
    () => browserHasSpeechRecognition(window),
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [file, setFile] = useState<{ ok?: string; error?: string; busy?: boolean }>({});
  const rec = useRef<Recognition | null>(null);

  function toggleDictation() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const w = window as unknown as Record<string, new () => Recognition>;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = document.documentElement.lang || "en-US";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const said = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (said) setText((t) => (t ? `${t} ${said}` : said));
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  async function attach(input: HTMLInputElement) {
    const chosen = input.files?.[0];
    if (!chosen) return;
    setFile({ busy: true });
    const body = new FormData();
    body.set("file", chosen);
    if (threadId) body.set("threadId", threadId);
    const res = await fetch("/api/ask/files", { method: "POST", body });
    const out = (await res.json().catch(() => ({}))) as {
      threadId?: string;
      filename?: string;
      scanStatus?: string;
      error?: string;
    };
    input.value = "";
    if (!res.ok) return setFile({ error: out.error ?? "The upload failed. Nothing was saved." });
    setFile({
      ok:
        out.scanStatus === "CLEAN"
          ? `Attached ${out.filename}. Ask about it below.`
          : `Attached ${out.filename}, but it has not passed the malware scan yet, so it cannot be read.`,
    });
    if (out.threadId && out.threadId !== threadId) router.push(`/ask/${out.threadId}`);
    else router.refresh();
  }

  const showDictation = dictationOffered({
    workspaceEnabled: voiceEnabled,
    browserSupported: supported,
  });
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        {threadId ? <input type="hidden" name="threadId" value={threadId} /> : null}
        <Label htmlFor="ask-question" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Ask about your accounts
        </Label>
        <Textarea
          id="ask-question"
          name="question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          maxLength={2000}
          rows={3}
          placeholder="Which renewals in the next 90 days have open escalations?"
          className="rounded-xl border-border/80 bg-background/80 focus-visible:ring-1 focus-visible:ring-primary shadow-xs text-sm leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending} className="shadow-xs font-medium">
            {pending ? "Reading your records…" : "Ask"}
          </Button>
          {showDictation ? (
            <Button
              type="button"
              variant="outline"
              onClick={toggleDictation}
              aria-pressed={listening}
              data-testid="dictation-button"
            >
              {listening ? "Stop dictation" : "Dictate"}
            </Button>
          ) : null}
        </div>
        {showDictation ? (
          <p className="text-muted-foreground text-xs" data-testid="dictation-disclosure">
            {disclosure}
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        ) : null}
      </form>
      <div className="space-y-1.5 border-t border-border/60 pt-3">
        <Label htmlFor="ask-file" className="text-xs text-muted-foreground font-medium">
          Attach a file (PDF, txt, vtt, srt or json, up to 25 MB)
        </Label>
        <input
          id="ask-file"
          type="file"
          accept={accept}
          disabled={file.busy}
          className="text-muted-foreground file:bg-secondary file:text-secondary-foreground file:hover:bg-hover block text-xs file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:px-3 file:py-1 file:text-xs file:font-medium"
          onChange={(e) => void attach(e.currentTarget)}
        />
        <p
          role={file.error ? "alert" : "status"}
          className={file.error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
        >
          {file.busy ? "Uploading and scanning…" : (file.error ?? file.ok ?? "")}
        </p>
        <p className="text-muted-foreground text-[11px]">
          Only you can read an attached file, and only after it passes the malware scan.
        </p>
      </div>
    </div>
  );
}
