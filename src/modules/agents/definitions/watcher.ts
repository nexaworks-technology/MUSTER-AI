import type { ExtractionKind } from "@prisma/client";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import {
  chunkTranscript,
  DEFAULT_THEMES,
  extractionModelOutput,
  groupableTheme,
  planReextract,
  planSources,
  StaleReextractError,
  validateExtraction,
  type WatchedSource,
} from "@/modules/conversations/service";
import { defineAgent, type Effect } from "../define";
import { createOnce, runAgent, type ExecutorDeps } from "../executor";
import { baseAgentOutput, type ContextBundle } from "../schemas";

/**
 * Watcher (spec §6E1, ARCHITECTURE §5.3; M4 basic, M9 full): one extraction call per email or
 * ticket message (either direction), CSM note, or call-transcript chunk. Every item's quote is
 * verified against the source it was read from — for a call, against its own chunk — before it is
 * written (D-75); an unverifiable quote is dropped and counted. Ticket-message sentiment feeds the
 * Sentiment pillar as data (M4 path, unchanged). Our own messages yield only PROMISE, ACTION_ITEM
 * and DECISION: the customer-only labels describe the customer's words, not ours.
 */
export const WATCHER_PROMPT = { name: "watcher-extraction", version: "1.1.0" } as const;

/** Kinds that may be read from a message we sent. */
const OURS_OK: ReadonlySet<ExtractionKind> = new Set(["PROMISE", "ACTION_ITEM", "DECISION"]);

export const watcherOutput = z.object({ ...baseAgentOutput.shape, ...extractionModelOutput.shape });
export type WatcherOutput = z.infer<typeof watcherOutput>;

export const watcherInput = z.object({
  sourceType: z.enum(["MESSAGE", "NOTE", "CALL_TRANSCRIPT"]),
  sourceId: z.string().min(1),
  /** Which chunk of a long source; always 0 for a message or note. */
  chunkIndex: z.number().int().min(0).default(0),
});
export type WatcherInput = z.infer<typeof watcherInput>;

const RECORD_TYPE = {
  MESSAGE: "Message",
  NOTE: "Note",
  CALL_TRANSCRIPT: "CallTranscript",
} as const;
const SOURCE_OF = { Message: "MESSAGE", Note: "NOTE", CallTranscript: "CALL_TRANSCRIPT" } as const;

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
          direction: m.direction,
          isTicketMessage: m.conversation.channel === "TICKET",
        }
      : null;
  }
  if (input.sourceType === "CALL_TRANSCRIPT") {
    const t = await db.callTranscript.findUnique({
      where: { id: input.sourceId },
      select: { accountId: true, title: true, text: true, account: { select: { name: true } } },
    });
    const chunk = t ? chunkTranscript(t.text)[input.chunkIndex] : undefined;
    return t && chunk
      ? {
          accountId: t.accountId,
          accountName: t.account.name,
          text: chunk.text,
          subject: t.title,
          direction: null,
          isTicketMessage: false,
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
        direction: null,
        isTicketMessage: false,
      }
    : null;
}

export const watcher = defineAgent({
  key: "watcher",
  version: "1.1.0",
  description:
    "Labels what one message, note or call-transcript chunk says, with verbatim quotes (extraction step)",
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
            fields: { subject: s.subject, direction: s.direction, text: s.text },
          },
        ]
      : [];
    return {
      bundle,
      accountId: s?.accountId,
      vars: { accountName: s?.accountName || "this account", themes: DEFAULT_THEMES.join(", ") },
    };
  },
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: "INTERNAL",
  async act(output, ctx) {
    const record = ctx.bundle[0];
    if (!record || !ctx.accountId) return { effects: [], actionTaken: "NONE" };
    const sourceType = SOURCE_OF[record.sourceType as keyof typeof SOURCE_OF];
    if (!sourceType) return { effects: [], actionTaken: "NONE" };
    const chunkIndex = watcherInput.parse(ctx.input).chunkIndex;
    const ours = record.fields.direction === "OUTBOUND";
    const source = String(record.fields.text ?? "");
    const checked = validateExtraction(source, output);
    // Our own words carry no customer sentiment or complaints: those labels are dropped and counted.
    const v = ours
      ? {
          kept: checked.kept.filter((k) => OURS_OK.has(k.kind)),
          sentiment: null,
          dropped: [
            ...checked.dropped,
            ...checked.kept
              .filter((k) => !OURS_OK.has(k.kind))
              .map((k) => ({
                index: k.itemIndex,
                kind: k.kind,
                reason: "customer-only label, not read from our own message",
              })),
          ],
        }
      : checked;
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
              chunkIndex,
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
                chunkIndex,
                itemIndex,
              },
            },
          }),
      );
    for (const k of v.kept) {
      // A theme is stored as a list entry or `other`; the model's own words are kept beside it.
      const payload = { ...k.payload };
      if ((k.kind === "COMPLAINT" || k.kind === "THEME") && typeof payload.theme === "string") {
        const grouped = groupableTheme(payload.theme, DEFAULT_THEMES);
        if (grouped !== payload.theme) payload.themeLabel = payload.theme;
        payload.theme = grouped ?? "other";
      }
      effects.push({
        type: "Extraction",
        id: (await write(k.itemIndex, k.kind, k.quote, payload, k.confidence, k.flags)).id,
      });
    }
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

async function planInputs(ctx: TenantContext, opts: { accountIds?: string[] }) {
  const db = scopedDb(ctx);
  const inAccounts = opts.accountIds ? { accountId: { in: opts.accountIds } } : {};
  const [messages, notes, transcripts, runs] = await Promise.all([
    db.message.findMany({
      where: inAccounts,
      select: { id: true, direction: true },
      orderBy: { sentAt: "asc" },
    }),
    db.note.findMany({ where: inAccounts, select: { id: true }, orderBy: { createdAt: "asc" } }),
    db.callTranscript.findMany({
      where: inAccounts,
      select: { id: true, text: true },
      orderBy: { occurredAt: "asc" },
    }),
    db.agentRun.findMany({
      where: { agentKey: watcher.key, triggerType: "extraction" },
      select: { triggerId: true },
    }),
  ]);
  return {
    messages,
    notes,
    transcripts: transcripts.map((t) => ({ id: t.id, chunks: chunkTranscript(t.text).length })),
    done: new Set(runs.map((r) => r.triggerId)),
    version: WATCHER_PROMPT.version,
  };
}

type Planned = Array<WatchedSource & { triggerId: string }>;

async function runPlanned(ctx: TenantContext, sources: Planned, deps: ExecutorDeps) {
  const counts: Record<string, number> = {};
  for (const s of sources) {
    const r = await runAgent(
      ctx,
      watcher,
      { sourceType: s.sourceType, sourceId: s.sourceId, chunkIndex: s.chunkIndex },
      { type: "extraction", id: s.triggerId },
      deps,
    );
    if (r.kind === "not_configured")
      return { notConfigured: true as const, reason: r.reason, counts };
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  return { notConfigured: false as const, sources: sources.length, counts };
}

/**
 * Every message (either direction), note and call-transcript chunk without a run at the current
 * prompt version, oldest first (M4 backfill, widened in M9). Re-running is safe: a source already
 * run under this prompt version is skipped, and each run is idempotent by its key. The 15-minute
 * sweep uses this for new records.
 */
export async function backfillExtractions(
  ctx: TenantContext,
  opts: { accountIds?: string[]; limit?: number } = {},
  deps: ExecutorDeps = {},
) {
  const sources = planSources({ ...(await planInputs(ctx, opts)), limit: opts.limit });
  return runPlanned(ctx, sources, deps);
}

/**
 * `conversations.reextract` (M9): after an explicit prompt-version bump, read again what the
 * earlier version read. `promptVersion` must be the current one (a stale request is refused), and
 * nothing happens unless an earlier version has actually run. Earlier extraction rows stay as
 * history; every reader takes the latest version per source.
 */
export async function reextractSources(
  ctx: TenantContext,
  opts: { promptVersion: string; accountIds?: string[]; limit?: number },
  deps: ExecutorDeps = {},
) {
  if (opts.promptVersion !== WATCHER_PROMPT.version)
    throw new StaleReextractError(
      `Re-extraction was asked for prompt ${opts.promptVersion}, but the Watcher is on ${WATCHER_PROMPT.version}.`,
    );
  const sources = planReextract({ ...(await planInputs(ctx, opts)), limit: opts.limit });
  return runPlanned(ctx, sources, deps);
}
