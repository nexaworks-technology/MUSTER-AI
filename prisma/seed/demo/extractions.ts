import { readFileSync } from "node:fs";
import path from "node:path";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import type { ScopedDb } from "@/lib/db/scoped";
import { runAgent, watcher } from "@/modules/agents/service";
import { triggerIdFor } from "@/modules/conversations/service";
import { syncInbox } from "@/modules/inbox/service";
import { ids, seedId } from "./ids";
import { atHour, daysAgo, SEED_TODAY } from "./dates";

/**
 * Extractions for the story sources (M9, D8). The REAL Watcher runs over each story record — its
 * validator, its AgentRun, its writes — and only the model's answer is replaced by a recorded one
 * kept in prisma/seed/fixtures/extractions/answers.json (mocks live in the seed only, Rule 6).
 * Every quote is checked against the real text by the Watcher: a wrong one would be dropped and
 * counted, and the seed test asserts none are. Sources with no recorded answer are left for the
 * Watcher's 15-minute sweep, exactly as in a real workspace.
 *
 * Ticket-thread messages carry no sentiment label here on purpose: the Sentiment pillar reads
 * those labels, and the seed must not move any seeded health score (D4).
 */
interface Answer {
  match: { transcript: string } | { text: string };
  output: Record<string, unknown>;
}
interface AnswerFile {
  note: string;
  answers: Answer[];
}

const FILE = path.join(import.meta.dirname, "../fixtures/extractions/answers.json");
export const loadAnswers = (): AnswerFile => JSON.parse(readFileSync(FILE, "utf8")) as AnswerFile;

/** Answers the real Watcher request from the recorded file; refuses anything it has no answer for. */
export function seedAnswerProvider(file: AnswerFile = loadAnswers()): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      const record = // The executor puts two sentences of instructions before the JSON records.
      (
        JSON.parse(req.input.slice(req.input.indexOf("[\n"))) as Array<{
          sourceType: string;
          sourceId: string;
          fields: { subject: string | null; text: string };
        }>
      )[0]!;
      const answer = file.answers.find((a) =>
        "transcript" in a.match
          ? record.sourceType === "CallTranscript" && record.fields.subject === a.match.transcript
          : record.fields.text === a.match.text,
      );
      if (!answer)
        throw new Error(
          `The seed has no recorded answer for ${record.sourceType} ${record.sourceId}`,
        );
      return {
        output: {
          ...answer.output,
          citations: [{ sourceType: record.sourceType, sourceId: record.sourceId }],
        } as T,
        stopReason: "end_turn",
        model: "recorded-seed",
        requestId: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      };
    },
  };
}

const SALTMARSH_NOTE_ID = seedId("note:saltmarsh:crm-deal");

export async function seedExtractions(db: ScopedDb, workspaceId: string): Promise<void> {
  const file = loadAnswers();
  const ctx = { workspaceId };
  const now = new Date(`${SEED_TODAY}T12:00:00Z`);

  // The CRM deal note that carries Saltmarsh's promised integration (Q-64, M6 carry-over).
  const noteData = {
    accountId: ids.account("saltmarsh"),
    body: file.note,
    tags: ["crm-deal-notes"],
    mentionMembershipIds: [] as string[],
    origin: "HUMAN" as const,
    source: "HUBSPOT" as const,
    createdAt: atHour(daysAgo(5), 13),
  };
  await db.note.upsert({
    where: { id: SALTMARSH_NOTE_ID },
    create: { id: SALTMARSH_NOTE_ID, workspaceId, ...noteData },
    update: noteData,
  });

  // The inbox is built from the emails and tickets that already exist (Rule 4).
  await syncInbox(ctx, { now });

  // An email nobody could place: waits in Unmatched until a person assigns it (D2).
  const held = {
    toAddresses: ["leo@larkspur.test"],
    subject: "Looking for a reporting tool for our finance team",
    bodyText:
      "Hello, a colleague gave us your name. We are a small finance team and would like to hear how your dashboards handle month-end reporting.",
    receivedAt: atHour(daysAgo(1), 16),
    reason: "No contact or account uses unknown-finance.test.",
    candidateAccountIds: [] as string[],
    status: "PENDING" as const,
    assignedAccountId: null,
    assignedMessageId: null,
    decidedByMembershipId: null,
    decidedAt: null,
  };
  await db.unmatchedInbound.upsert({
    where: {
      workspaceId_provider_externalId: {
        workspaceId,
        provider: "GMAIL",
        externalId: "seed-unmatched-1",
      },
    },
    create: {
      workspaceId,
      provider: "GMAIL",
      externalId: "seed-unmatched-1",
      fromAddress: "hello@unknown-finance.test",
      ...held,
    },
    update: held,
  });

  // Run the real Watcher over every story source that has a recorded answer.
  const provider = seedAnswerProvider(file);
  const deps = { provider, clock: () => now };
  const transcriptAnswers = new Set(
    file.answers.flatMap((a) => ("transcript" in a.match ? [a.match.transcript] : [])),
  );
  const textAnswers = new Set(
    file.answers.flatMap((a) => ("text" in a.match ? [a.match.text] : [])),
  );
  const [messages, notes, transcripts] = await Promise.all([
    db.message.findMany({
      where: { source: "SEED", direction: "INBOUND" },
      select: { id: true, bodyText: true },
    }),
    db.note.findMany({ select: { id: true, body: true } }),
    db.callTranscript.findMany({ where: { source: "SEED" }, select: { id: true, title: true } }),
  ]);
  const sources = [
    ...transcripts
      .filter((t) => transcriptAnswers.has(t.title))
      .map((t) => ({ sourceType: "CALL_TRANSCRIPT" as const, sourceId: t.id })),
    ...messages
      .filter((m) => textAnswers.has(m.bodyText))
      .map((m) => ({ sourceType: "MESSAGE" as const, sourceId: m.id })),
    ...notes
      .filter((n) => textAnswers.has(n.body))
      .map((n) => ({ sourceType: "NOTE" as const, sourceId: n.id })),
  ];
  for (const s of sources) {
    const r = await runAgent(
      ctx,
      watcher,
      { ...s, chunkIndex: 0 },
      { type: "extraction", id: triggerIdFor({ ...s, chunkIndex: 0 }, watcher.prompt.version) },
      deps,
    );
    if (r.kind === "not_configured")
      throw new Error(`The seed Watcher run was not configured: ${r.reason}`);
  }
}
