import type { ExtractionKind } from "@prisma/client";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import { extractionModelOutput, validateExtraction } from "@/modules/conversations/service";
import { defineAgent, type Effect } from "../define";
import { createOnce, runAgent, type ExecutorDeps } from "../executor";
import { baseAgentOutput, type ContextBundle } from "../schemas";

/**
 * Watcher-basic (spec §6E1, ARCHITECTURE §5.3; M4): one extraction call per existing ticket
 * message or note. Every item's quote is verified against the source before it is written (D-75);
 * an unverifiable quote is dropped and counted. Ticket-message sentiment feeds the Sentiment
 * pillar as data. Text-to-signal rules come in M9.
 */
export const WATCHER_PROMPT = { name: "watcher-extraction", version: "1.0.0" } as const;

export const watcherOutput = z.object({ ...baseAgentOutput.shape, ...extractionModelOutput.shape });
export type WatcherOutput = z.infer<typeof watcherOutput>;

export const watcherInput = z.object({
  sourceType: z.enum(["MESSAGE", "NOTE"]),
  sourceId: z.string().min(1),
});
export type WatcherInput = z.infer<typeof watcherInput>;

const RECORD_TYPE = { MESSAGE: "Message", NOTE: "Note" } as const;

export async function watcherSource(db: ScopedDb, input: WatcherInput) {
  if (input.sourceType === "MESSAGE") {
    const m = await db.message.findUnique({
      where: { id: input.sourceId },
      select: {
        id: true,
        accountId: true,
        subject: true,
        bodyText: true,
        direction: true,
        account: { select: { name: true } },
        conversation: { select: { channel: true } },
      },
    });
    return m
      ? {
          accountId: m.accountId,
          accountName: m.account.name,
          text: m.bodyText,
          subject: m.subject,
          isTicketMessage: m.conversation.channel === "TICKET",
        }
      : null;
  }
  const n = await db.note.findUnique({
    where: { id: input.sourceId },
    select: { id: true, accountId: true, body: true, account: { select: { name: true } } },
  });
  return n?.accountId
    ? {
        accountId: n.accountId,
        accountName: n.account?.name ?? "",
        text: n.body,
        subject: null,
        isTicketMessage: false,
      }
    : null;
}

export const watcher = defineAgent({
  key: "watcher",
  version: "1.0.0",
  description:
    "Labels what one ticket message or note says, with verbatim quotes (extraction step)",
  modelTier: "fast",
  tierReason: "High-volume, narrow labelling of one short record at a time (§6.1).",
  prompt: WATCHER_PROMPT,
  inputSchema: watcherInput,
  outputSchema: watcherOutput,
  async buildContext(db, input) {
    const s = await watcherSource(db, input);
    const bundle: ContextBundle = s
      ? [
          {
            sourceType: RECORD_TYPE[input.sourceType],
            sourceId: input.sourceId,
            fields: { subject: s.subject, text: s.text },
          },
        ]
      : [];
    return {
      bundle,
      accountId: s?.accountId,
      vars: { accountName: s?.accountName || "this account" },
    };
  },
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: "INTERNAL",
  async act(output, ctx) {
    const record = ctx.bundle[0];
    if (!record || !ctx.accountId) return { effects: [], actionTaken: "NONE" };
    const sourceType = record.sourceType === "Message" ? "MESSAGE" : "NOTE";
    const source = String(record.fields.text ?? "");
    const v = validateExtraction(source, output);
    const effects: Effect[] = [];
    const write = (
      itemIndex: number,
      kind: ExtractionKind,
      quote: string,
      payload: object,
      confidence: number,
      flags: string[],
    ) =>
      createOnce(
        () =>
          ctx.db.extraction.create({
            data: {
              workspaceId: ctx.workspaceId,
              sourceType,
              sourceId: record.sourceId,
              accountId: ctx.accountId!,
              kind,
              quote,
              payload: payload as object,
              confidence,
              flags,
              promptVersion: WATCHER_PROMPT.version,
              itemIndex,
              agentRunId: ctx.runId,
            },
          }),
        () =>
          ctx.db.extraction.findUnique({
            where: {
              workspaceId_sourceType_sourceId_promptVersion_chunkIndex_itemIndex: {
                workspaceId: ctx.workspaceId,
                sourceType,
                sourceId: record.sourceId,
                promptVersion: WATCHER_PROMPT.version,
                chunkIndex: 0,
                itemIndex,
              },
            },
          }),
      );
    for (const k of v.kept)
      effects.push({
        type: "Extraction",
        id: (await write(k.itemIndex, k.kind, k.quote, k.payload, k.confidence, k.flags)).id,
      });
    if (v.sentiment) {
      // itemIndex -1 is the record's overall sentiment, kept apart from the item list.
      const row = await write(
        -1,
        "SENTIMENT",
        v.sentiment.quote,
        { label: v.sentiment.label },
        output.confidence,
        [],
      );
      effects.push({ type: "Extraction", id: row.id });
      if (sourceType === "MESSAGE") {
        await ctx.db.message.update({
          where: { id: record.sourceId },
          data: { sentimentLabel: v.sentiment.label, sentimentAgentRunId: ctx.runId },
        });
        effects.push({ type: "Message", id: record.sourceId });
      }
    }
    for (const d of v.dropped)
      effects.push({ type: "DroppedExtraction", id: `item ${d.index} (${d.kind}): ${d.reason}` });
    if (v.dropped.length)
      logger.warn(
        { runId: ctx.runId, dropped: v.dropped.length, reasons: v.dropped.map((d) => d.reason) },
        "extraction items dropped (unverifiable)",
      );
    return {
      effects,
      actionTaken: effects.some((e) => e.type === "Extraction") ? "EXECUTED" : "NONE",
    };
  },
});

/**
 * Watcher-basic backfill (M4): every existing inbound message and note without an extraction for
 * the current prompt version, oldest first. Re-running is safe: a source already run under this
 * prompt version is skipped, and each run is idempotent by its key.
 */
export async function backfillExtractions(
  ctx: TenantContext,
  opts: { accountIds?: string[]; limit?: number } = {},
  deps: ExecutorDeps = {},
) {
  const db = scopedDb(ctx);
  const inAccounts = opts.accountIds ? { accountId: { in: opts.accountIds } } : {};
  const [messages, notes, done] = await Promise.all([
    db.message.findMany({
      where: { ...inAccounts, direction: "INBOUND" },
      select: { id: true },
      orderBy: { sentAt: "asc" },
    }),
    db.note.findMany({ where: inAccounts, select: { id: true }, orderBy: { createdAt: "asc" } }),
    db.agentRun.findMany({
      where: {
        agentKey: watcher.key,
        triggerType: "extraction",
        triggerId: { endsWith: `@${WATCHER_PROMPT.version}` },
      },
      select: { triggerId: true },
    }),
  ]);
  const seen = new Set(done.map((d) => d.triggerId));
  const sources = [
    ...messages.map((m) => ({ sourceType: "MESSAGE" as const, sourceId: m.id })),
    ...notes.map((n) => ({ sourceType: "NOTE" as const, sourceId: n.id })),
  ]
    .map((s) => ({ ...s, triggerId: `${s.sourceType}:${s.sourceId}@${WATCHER_PROMPT.version}` }))
    .filter((s) => !seen.has(s.triggerId))
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  const counts: Record<string, number> = {};
  for (const s of sources) {
    const r = await runAgent(
      ctx,
      watcher,
      { sourceType: s.sourceType, sourceId: s.sourceId },
      { type: "extraction", id: s.triggerId },
      deps,
    );
    if (r.kind === "not_configured")
      return { notConfigured: true as const, reason: r.reason, counts };
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  return { notConfigured: false as const, sources: sources.length, counts };
}
