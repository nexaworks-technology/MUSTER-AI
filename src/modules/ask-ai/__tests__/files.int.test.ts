import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { askQuestion, attachFile, readAttachmentText, runAskTool, type AskActor } from "../service";
import { buildPdf } from "./pdf-fixture";

/**
 * M11 S11 (acceptance #14): a file attached in Ask AI is read only when the malware scan is CLEAN,
 * only by its uploader, and cited by character offsets. PENDING and REJECTED files are never read.
 */
const SENTENCE = "Either party may terminate with 60 days' written notice.";

async function colleague(ws: string): Promise<AskActor> {
  const user = await rawDb.user.create({ data: { email: `csm-${randomUUID()}@example.test` } });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: { workspaceId: ws, userId: user.id, role: "CSM", bookScope: "OWN" },
    });
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  };
}

let A: AskActor;
let other: AskActor;
let B: AskActor;
let cleanPdf: { threadId: string; fileId: string };
let pending: { threadId: string; fileId: string };
let txt: { threadId: string; fileId: string };
let rejectedId: string;

beforeAll(async () => {
  A = (await createTestAdmin("AskFilesA")).actor;
  B = (await createTestAdmin("AskFilesB")).actor;
  other = await colleague(A.workspaceId);
  cleanPdf = await attachFile(A, { filename: "terms.pdf", bytes: buildPdf(SENTENCE) });
  txt = await attachFile(A, {
    threadId: cleanPdf.threadId,
    filename: "notes.txt",
    bytes: new TextEncoder().encode("Kickoff notes.\nThe customer asked about SSO in March."),
  });
  pending = await attachFile(
    A,
    { filename: "later.pdf", bytes: buildPdf("Secret pending text.") },
    { scanner: null },
  );
  const rej = await scopedDb(A).fileObject.create({
    data: {
      workspaceId: A.workspaceId,
      purpose: "ASK_ATTACHMENT",
      storageKey: `ws/${A.workspaceId}/files/${randomUUID()}`,
      filename: "bad.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      sha256: "x",
      scanStatus: "REJECTED",
      uploadedByMembershipId: A.membershipId,
    },
  });
  rejectedId = rej.id;
});

describe("Ask AI file reading", () => {
  it("reads a CLEAN PDF and returns passages with character offsets", async () => {
    const t = await readAttachmentText(A, cleanPdf.fileId);
    // PDF's standard font encoding renders the straight apostrophe as a typographic one.
    expect(t.ok && t.text.replaceAll("\u2019", "'")).toContain(SENTENCE);
    const out = await runAskTool(A, "readUploadedFile", {
      fileId: cleanPdf.fileId,
      query: "terminate",
    });
    expect(out.notFound).toBeNull();
    const r = out.records[0]!;
    expect(r.type).toBe("FileObject");
    expect(r.ref).toMatch(new RegExp(`^FileObject:${cleanPdf.fileId}#\\d+-\\d+$`));
    expect(r.id).toBe(r.ref.slice("FileObject:".length));
    const { start, end, text } = r.fields as { start: number; end: number; text: string };
    expect(text.replaceAll("\u2019", "'")).toContain("60 days' written notice");
    expect(r.ref.endsWith(`#${start}-${end}`)).toBe(true);
    expect(end - start).toBe(text.length);
  });

  it("reads a text file; without a query it returns the first chunk", async () => {
    const out = await runAskTool(A, "readUploadedFile", { fileId: txt.fileId });
    expect(out.records[0]!.fields.start).toBe(0);
    expect(JSON.stringify(out.records)).toContain("SSO in March");
  });

  it("a PENDING file is never read (acceptance #14)", async () => {
    const t = await readAttachmentText(A, pending.fileId);
    expect(t).toMatchObject({ ok: false, reason: "NOT_SCANNED" });
    const out = await runAskTool(A, "readUploadedFile", { fileId: pending.fileId });
    expect(out.records).toEqual([]);
    expect(out.notFound).toBe(
      "This file has not passed the malware scan yet, so I did not read it.",
    );
  });

  it("a REJECTED file is never read", async () => {
    const out = await runAskTool(A, "readUploadedFile", { fileId: rejectedId });
    expect(out.records).toEqual([]);
    expect(out.notFound).toMatch(/not passed the malware scan/i);
  });

  it("another member of the same workspace cannot read it, nor can another workspace", async () => {
    for (const who of [other, B]) {
      const out = await runAskTool(who, "readUploadedFile", { fileId: cleanPdf.fileId });
      expect(out.records).toEqual([]);
      expect(JSON.stringify(out)).not.toContain("terminate");
      expect(out.notFound).toMatch(/cannot see a file/i);
    }
  });

  it("an unreadable PDF is reported, not invented", async () => {
    const bad = await attachFile(A, {
      filename: "broken.pdf",
      bytes: new Uint8Array(Buffer.from("%PDF-1.4\nnot really a pdf\n", "latin1")),
    }).catch(() => null);
    // The upload check may refuse it first (also acceptable); if stored, reading says so plainly.
    if (bad) {
      const out = await runAskTool(A, "readUploadedFile", { fileId: bad.fileId });
      expect(out.records).toEqual([]);
      expect(out.notFound).toMatch(/could not read/i);
    }
  });
});

describe("attaching and asking about a file", () => {
  it("an attachment creates a thread-bound message; fileIds must belong to the thread", async () => {
    const msgs = await scopedDb(A).askMessage.findMany({ where: { threadId: cleanPdf.threadId } });
    expect(msgs.map((m) => m.content)).toEqual(["Attached terms.pdf", "Attached notes.txt"]);
    // A file from another thread, and a file of someone else, are refused.
    await expect(
      askQuestion(A, {
        question: "What does it say?",
        threadId: cleanPdf.threadId,
        fileIds: [pending.fileId],
      }),
    ).rejects.toThrow(/not attached/i);
    await expect(
      askQuestion(other, {
        question: "x",
        threadId: cleanPdf.threadId,
        fileIds: [cleanPdf.fileId],
      }),
    ).rejects.toThrow();
  });

  it("the planner is told the attached file ids", async () => {
    const seen: string[] = [];
    await askQuestion(
      A,
      { question: "Notice period?", threadId: cleanPdf.threadId, fileIds: [cleanPdf.fileId] },
      {
        provider: {
          name: "recorded",
          async generateStructured(req) {
            seen.push(req.input);
            return {
              output: req.schema.parse(
                req.promptRef.startsWith("ask-ai-plan@") ? { action: "answer" } : {},
              ),
              stopReason: "end_turn",
              model: "test-model",
              requestId: randomUUID(),
              inputTokens: 1,
              outputTokens: 1,
              latencyMs: 1,
            };
          },
        },
      },
    ).catch(() => undefined); // the answer step's schema is not under test here
    expect(seen[0]).toContain(cleanPdf.fileId);
    expect(seen[0]).toContain("terms.pdf");
  });
});
