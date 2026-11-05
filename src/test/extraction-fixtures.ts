import type { ExtractionKind, ExtractionSourceType } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";

/** Test helper (M9): an Extraction row with the Watcher run behind it, as the real Watcher writes it. */
export async function addExtraction(
  db: ScopedDb,
  o: {
    workspaceId: string;
    accountId: string;
    sourceType: ExtractionSourceType;
    sourceId: string;
    kind: ExtractionKind;
    quote: string;
    payload?: Record<string, unknown>;
    version?: string;
    itemIndex?: number;
    chunkIndex?: number;
    createdAt?: Date;
  },
) {
  const version = o.version ?? "1.1.0";
  const chunk = o.chunkIndex ?? 0;
  const triggerId =
    o.sourceType === "CALL_TRANSCRIPT"
      ? `CALL_TRANSCRIPT:${o.sourceId}#${chunk}@${version}`
      : `${o.sourceType}:${o.sourceId}@${version}`;
  const run =
    (await db.agentRun.findFirst({ where: { agentKey: "watcher", triggerId } })) ??
    (await db.agentRun.create({
      data: {
        workspaceId: o.workspaceId,
        agentKey: "watcher",
        agentVersion: version,
        promptName: "watcher-extraction",
        promptVersion: version,
        model: "recorded",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId,
        idempotencyKey: `${triggerId}-${Math.random().toString(36).slice(2)}`,
        inputRefs: [{ sourceType: "Message", sourceId: o.sourceId }],
        accountId: o.accountId,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    }));
  return db.extraction.create({
    data: {
      workspaceId: o.workspaceId,
      sourceType: o.sourceType,
      sourceId: o.sourceId,
      accountId: o.accountId,
      kind: o.kind,
      quote: o.quote,
      payload: (o.payload ?? {}) as object,
      confidence: 0.9,
      promptVersion: version,
      itemIndex: o.itemIndex ?? 0,
      chunkIndex: chunk,
      agentRunId: run.id,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
}
