import { extractText, getDocumentProxy } from "unpdf";
import { scopedDb } from "@/lib/db/scoped";
import {
  FileNotFoundError,
  readFile,
  storeUpload,
  UploadRejectedError,
  type FileDeps,
} from "@/modules/files/service";
import type { AskActor } from "./tools";

/**
 * File Q&A (M11 S11, D-165). A file attached in Ask AI is the asker's own: it is read only when
 * the malware scan says CLEAN (Q-18: PENDING and REJECTED files are never opened), only by the
 * member who uploaded it, and only as text with character offsets so an answer can cite the exact
 * passage (`FileObject:<id>#<start>-<end>`). Nothing here sends the file anywhere.
 */
export const MAX_FILE_TEXT_CHARS = 200_000;
export const NOT_SCANNED = "This file has not passed the malware scan yet, so I did not read it.";
export const FILE_NOT_VISIBLE = "I cannot see a file with that id among your attachments.";

export type FileTextResult =
  | { ok: true; fileName: string; text: string; truncated: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NOT_SCANNED" | "UNREADABLE"; message: string };

/** The asker's own ASK_ATTACHMENT row, or null (other member, other workspace, other purpose). */
async function ownAttachment(actor: AskActor, fileId: string) {
  return scopedDb(actor).fileObject.findFirst({
    where: {
      id: fileId,
      purpose: "ASK_ATTACHMENT",
      uploadedByMembershipId: actor.membershipId,
    },
  });
}

export async function readAttachmentText(
  actor: AskActor,
  fileId: string,
  deps: FileDeps = {},
): Promise<FileTextResult> {
  const file = await ownAttachment(actor, fileId);
  if (!file) return { ok: false, reason: "NOT_FOUND", message: FILE_NOT_VISIBLE };
  if (file.scanStatus !== "CLEAN")
    return { ok: false, reason: "NOT_SCANNED", message: NOT_SCANNED };
  let bytes: Uint8Array;
  try {
    bytes = (await readFile(actor, file.id, deps)).bytes;
  } catch (e) {
    if (e instanceof FileNotFoundError)
      return { ok: false, reason: "NOT_FOUND", message: FILE_NOT_VISIBLE };
    throw e;
  }
  try {
    const raw =
      file.mimeType === "application/pdf"
        ? (await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true }))
            .text
        : new TextDecoder("utf-8").decode(bytes);
    const text = raw.replace(/\r\n?/g, "\n");
    return {
      ok: true,
      fileName: file.filename,
      text: text.slice(0, MAX_FILE_TEXT_CHARS),
      truncated: text.length > MAX_FILE_TEXT_CHARS,
    };
  } catch {
    return {
      ok: false,
      reason: "UNREADABLE",
      message: `I could not read the text in ${file.filename}.`,
    };
  }
}

export interface Passage {
  start: number;
  end: number;
  text: string;
}

const CHUNK = 1500;
const CONTEXT = 400;
const MAX_PASSAGES = 5;

/** Windows around matches of the query (whole phrase, else its words), else the first chunks. */
export function selectPassages(text: string, query?: string): Passage[] {
  const q = query?.trim().toLowerCase();
  const lower = text.toLowerCase();
  const hits: number[] = [];
  if (q) {
    const needles = lower.includes(q) ? [q] : q.split(/\s+/).filter((w) => w.length >= 3);
    for (const n of needles)
      for (
        let i = lower.indexOf(n);
        i !== -1 && hits.length < 200;
        i = lower.indexOf(n, i + n.length)
      )
        hits.push(i);
  }
  const windows: Array<[number, number]> = [];
  for (const h of hits.sort((a, b) => a - b)) {
    const w: [number, number] = [Math.max(0, h - CONTEXT), Math.min(text.length, h + CONTEXT)];
    const last = windows[windows.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else windows.push(w);
  }
  if (windows.length === 0)
    for (let s = 0; s < text.length && windows.length < 4; s += CHUNK)
      windows.push([s, Math.min(text.length, s + CHUNK)]);
  return windows.slice(0, MAX_PASSAGES).map(([start, end]) => ({
    start,
    end,
    text: text.slice(start, end),
  }));
}

/** Ids of attachments linked to a thread (owner-only thread) that this member uploaded. */
export async function threadAttachmentIds(actor: AskActor, threadId: string): Promise<string[]> {
  const rows = await scopedDb(actor).askMessage.findMany({
    where: { threadId, role: "USER", toolCalls: { path: ["attachments"], not: "null" } },
    select: { toolCalls: true },
    orderBy: { createdAt: "asc" },
  });
  const ids = rows.flatMap((r) => {
    const a = (r.toolCalls as { attachments?: unknown } | null)?.attachments;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  });
  return [...new Set(ids)];
}

/**
 * Attach a file to an Ask thread (creating the thread when none is given): validated and scanned
 * by the files service under purpose ASK_ATTACHMENT, then recorded as a USER message that lists
 * the file id — the link that binds the file to this thread. Returns the scan state honestly.
 */
export async function attachFile(
  actor: AskActor,
  input: { threadId?: string; filename: string; bytes: Uint8Array },
  deps: FileDeps = {},
) {
  const db = scopedDb(actor);
  if (input.threadId) {
    const t = await db.askThread.findFirst({
      where: { id: input.threadId, membershipId: actor.membershipId },
      select: { id: true },
    });
    if (!t) throw new FileNotFoundError();
  }
  const file = await storeUpload(
    actor,
    { purpose: "ASK_ATTACHMENT", filename: input.filename, bytes: input.bytes },
    deps,
  );
  const threadId =
    input.threadId ??
    (
      await db.askThread.create({
        data: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          membershipId: actor.membershipId,
          title: `File: ${file.filename}`.slice(0, 120),
        },
      })
    ).id;
  await db.askMessage.create({
    data: {
      workspaceId: actor.workspaceId,
      threadId,
      role: "USER",
      content: `Attached ${file.filename}${file.scanStatus === "CLEAN" ? "" : " (waiting for the malware scan; it cannot be read yet)"}`,
      toolCalls: { attachments: [file.id] },
    },
  });
  return { threadId, fileId: file.id, filename: file.filename, scanStatus: file.scanStatus };
}

export { UploadRejectedError };
