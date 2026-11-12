"use client";

import { useRouter } from "next/navigation";
import { ArrowUp, ArrowUpRight, Mic, Paperclip } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StarburstMark } from "@/components/app/starburst";
import { Label } from "@/components/ui/label";
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

/** Starter questions on an empty conversation. They only fill the box; the person still asks. */
const STARTERS = [
  "Which accounts are at risk and why?",
  "Which accounts mentioned a competitor this month?",
  "Which renewals in the next 90 days have open escalations?",
];

/**
 * The Ask AI box: a question, optional file attachment, and (Q-11) browser dictation when the
 * Admin turned it on. Dictation only fills this text box; audio never reaches our servers.
 *
 * The question box is deliberately UNCONTROLLED. A controlled textarea is reset to its state when
 * React hydrates, which silently dropped the first characters of a question typed while the page's
 * scripts were still loading (the clipped thread titles, "hich accounts are at risk...").
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
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // The browser capability is only known on the client; the server render assumes "no".
  const supported = useSyncExternalStore(
    () => () => {},
    () => browserHasSpeechRecognition(window),
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [file, setFile] = useState<{ ok?: string; error?: string; busy?: boolean }>({});
  const rec = useRef<Recognition | null>(null);

  /** The composer grows with its text, up to about ten lines. */
  function grow() {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  // Text typed before hydration is already in the box, and the form clears after an answer:
  // size the box to whatever it holds, on mount and whenever a question finishes.
  useEffect(grow, [pending]);

  function fill(text: string, append: boolean) {
    const el = box.current;
    if (!el) return;
    el.value = append && el.value ? `${el.value} ${text}` : text;
    grow();
    el.focus();
  }

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
      if (said) fill(said, true);
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
  const icon =
    "text-muted-foreground hover:bg-ask-wash hover:text-foreground flex size-9 items-center justify-center rounded-full transition-colors";
  return (
    <div className="space-y-3">
      {pending ? (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-2 px-1 text-sm"
          data-testid="ask-reading"
        >
          <StarburstMark className="text-ask-accent size-4 animate-pulse motion-reduce:animate-none" />
          Reading your records…
        </p>
      ) : null}
      <div className="ask-composer-shadow bg-ask-composer border-ask-line focus-within:border-ask-pill-line rounded-3xl border px-3 pt-2 pb-2">
        <form
          id="ask-form"
          ref={form}
          action={action}
          onKeyDown={(e) => {
            // Enter asks; Shift+Enter is a new line; never while an IME is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              form.current?.requestSubmit();
            }
          }}
        >
          {threadId ? <input type="hidden" name="threadId" value={threadId} /> : null}
          <Label htmlFor="ask-question" className="sr-only">
            Ask about your accounts
          </Label>
          <textarea
            id="ask-question"
            ref={box}
            name="question"
            required
            maxLength={2000}
            rows={1}
            onInput={grow}
            placeholder="Which renewals in the next 90 days have open escalations?"
            className="placeholder:text-placeholder block max-h-60 w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-6 outline-none"
          />
        </form>
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-0.5">
            {/* Outside the form on purpose: a chosen file must never ride along with a question. */}
            <input
              id="ask-file"
              type="file"
              accept={accept}
              disabled={file.busy}
              className="peer sr-only"
              onChange={(e) => void attach(e.currentTarget)}
            />
            <Label
              htmlFor="ask-file"
              className={`${icon} peer-focus-visible:ring-ring cursor-pointer peer-focus-visible:ring-2 peer-disabled:opacity-50`}
            >
              <Paperclip className="size-[18px]" aria-hidden="true" />
              <span className="sr-only">
                Attach a file (PDF, txt, vtt, srt or json, up to 25 MB)
              </span>
            </Label>
            {showDictation ? (
              <button
                type="button"
                onClick={toggleDictation}
                aria-pressed={listening}
                data-testid="dictation-button"
                className={`${icon} focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none ${listening ? "bg-ask-wash text-foreground" : ""}`}
              >
                <Mic className="size-[18px]" aria-hidden="true" />
                <span className="sr-only">{listening ? "Stop dictation" : "Dictate"}</span>
              </button>
            ) : null}
          </div>
          <button
            type="submit"
            form="ask-form"
            disabled={pending}
            className="bg-ask-accent text-ask-accent-foreground hover:bg-ask-accent-hover focus-visible:ring-ring flex size-9 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            <ArrowUp className="size-[18px]" aria-hidden="true" />
            <span className="sr-only">Ask</span>
          </button>
        </div>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive px-1 text-sm">
          {state.error}
        </p>
      ) : null}
      <p
        role={file.error ? "alert" : "status"}
        className={
          file.error ? "text-destructive px-1 text-xs" : "text-muted-foreground px-1 text-xs"
        }
      >
        {file.busy ? "Uploading and scanning…" : (file.error ?? file.ok ?? "")}
      </p>
      {showDictation ? (
        <p className="text-muted-foreground px-1 text-xs" data-testid="dictation-disclosure">
          {disclosure}
        </p>
      ) : null}
      <p className="text-muted-foreground px-1 text-[11px]">
        Only you can read an attached file, and only after it passes the malware scan.
      </p>
      {!threadId ? (
        <div className="pt-4">
          <h2 className="text-muted-foreground px-1 pb-1 text-xs font-medium">Try asking</h2>
          <ul>
            {STARTERS.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  onClick={() => fill(q, false)}
                  className="text-foreground hover:bg-ask-wash focus-visible:ring-ring group flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  {q}
                  <ArrowUpRight
                    className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
