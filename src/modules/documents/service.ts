import type { Document, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import {
  getAccount,
  requireEditableAccount,
  AccountNotFoundError,
  type Actor,
} from "@/modules/accounts/service";
import { canSeeMoney } from "@/modules/billing/service";
import {
  renderNarrative,
  validateNarrative,
  type NarrativeBlock,
  type NarrativeProblem,
} from "./placeholders";

export { renderNarrative, validateNarrative, type NarrativeBlock, type NarrativeProblem };

/**
 * Documents with locked metrics (M7 B3, ARCHITECTURE §3.2). `metrics` is a snapshot computed by
 * code and locked at creation (a database trigger refuses any later change); `narrative` is text
 * whose numbers appear only as {{metric.key}} placeholders, validated on every write and rendered
 * from the locked metrics on every read. Money metrics read "Restricted" without revenue access.
 * Reused by QBRs (M10).
 */
export class DocumentError extends Error {
  constructor(
    message: string,
    readonly problems: NarrativeProblem[] = [],
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export const sourceRef = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
});

export const metricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** How the figure reads; informational, the text below is what a placeholder inserts. */
  kind: z.enum(["text", "number", "percent", "date", "money"]),
  value: z.union([z.string(), z.number()]).nullable(),
  /** Exactly what a {{metric.key}} placeholder renders. */
  text: z.string().min(1),
  /** True for money: hidden without revenue access (spec §6N5). */
  money: z.boolean().default(false),
  sources: z.array(sourceRef).default([]),
});
export type Metric = z.infer<typeof metricSchema>;
export type MetricSet = Record<string, Metric>;
const metricSetSchema = z.record(z.string(), metricSchema);

export const narrativeBlockSchema = z.object({
  id: z.string().min(1).max(60),
  type: z.enum(["heading", "paragraph", "bullet"]),
  text: z.string().min(1).max(2_000),
});
export const narrativeSchema = z.array(narrativeBlockSchema).max(60);

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const texts = (m: MetricSet) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.text]));

/** Validates against the metrics' own keys; throws with every problem listed. */
export function assertNarrative(blocks: NarrativeBlock[], metrics: MetricSet): void {
  const problems = validateNarrative(blocks, Object.keys(metrics), texts(metrics));
  if (problems.length)
    throw new DocumentError(
      `The narrative cannot be saved: ${problems.map((p) => p.message).join("; ")}.`,
      problems,
    );
}

export interface NewDocument {
  accountId: string;
  kind: Document["kind"];
  title: string;
  metrics: MetricSet;
  narrative: NarrativeBlock[];
  origin: "SYSTEM" | "AI" | "HUMAN";
  agentRunId?: string | null;
}

/** Creates a document with its metrics locked now. The narrative is validated first. */
export async function createDocument(
  ctx: TenantContext,
  input: NewDocument,
  tx?: Prisma.TransactionClient,
): Promise<Document> {
  const metrics = metricSetSchema.parse(input.metrics);
  const narrative = narrativeSchema.parse(input.narrative);
  assertNarrative(narrative, metrics);
  const write = async (t: Prisma.TransactionClient) => {
    const doc = await t.document.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: input.accountId,
        kind: input.kind,
        title: input.title,
        metrics: json(metrics),
        narrative: json(narrative),
        origin: input.origin,
        agentRunId: input.agentRunId ?? null,
        lockedAt: new Date(),
      },
    });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: input.origin === "AI" ? "AGENT" : "SYSTEM",
        actorId: input.agentRunId ?? null,
        action: "document.created",
        targetType: "Document",
        targetId: doc.id,
        summary: `Created ${input.title} with ${Object.keys(metrics).length} locked metrics`,
      },
      t,
    );
    return doc;
  };
  return tx ? write(tx) : scopedDb(ctx).$tenantTransaction(write);
}

export interface DocumentView {
  id: string;
  accountId: string;
  kind: Document["kind"];
  title: string;
  origin: Document["origin"];
  agentRunId: string | null;
  lockedAt: Date | null;
  metrics: Metric[];
  /** Blocks as stored: with placeholders (what an editor changes). */
  template: NarrativeBlock[];
  /** Blocks with every placeholder replaced by its locked metric (what a reader sees). */
  rendered: NarrativeBlock[];
  moneyVisible: boolean;
  canEdit: boolean;
}

function hideMoney(m: Metric): Metric {
  return m.money ? { ...m, value: null, text: "Restricted" } : m;
}

export async function readDocument(actor: Actor, id: string): Promise<DocumentView> {
  const doc = await scopedDb(actor).document.findUnique({
    where: { workspaceId_id: { workspaceId: actor.workspaceId, id } },
  });
  const account = doc ? await getAccount(actor, doc.accountId) : null;
  if (!doc || !account) throw new DocumentError("This document does not exist.");
  const visible = canSeeMoney(actor);
  const stored = metricSetSchema.parse(doc.metrics);
  const metrics = Object.fromEntries(
    Object.entries(stored).map(([k, m]) => [k, visible ? m : hideMoney(m)]),
  );
  const template = narrativeSchema.parse(doc.narrative);
  return {
    id: doc.id,
    accountId: doc.accountId,
    kind: doc.kind,
    title: doc.title,
    origin: doc.origin,
    agentRunId: doc.agentRunId,
    lockedAt: doc.lockedAt,
    metrics: Object.values(metrics),
    template,
    rendered: renderNarrative(template, metrics),
    moneyVisible: visible,
    canEdit: account.canEdit,
  };
}

/** A person edits the narrative; the metrics never change. Same validator as for the agent. */
export async function updateNarrative(actor: Actor, id: string, raw: unknown): Promise<void> {
  const blocks = narrativeSchema.parse(raw);
  const db = scopedDb(actor);
  const doc = await db.document.findUnique({
    where: { workspaceId_id: { workspaceId: actor.workspaceId, id } },
  });
  if (!doc) throw new DocumentError("This document does not exist.");
  try {
    await requireEditableAccount(actor, doc.accountId);
  } catch (e) {
    if (e instanceof AccountNotFoundError) throw new DocumentError("This document does not exist.");
    throw e;
  }
  assertNarrative(blocks, metricSetSchema.parse(doc.metrics));
  await db.$tenantTransaction(async (tx) => {
    await tx.document.update({
      where: { workspaceId_id: { workspaceId: actor.workspaceId, id } },
      data: { narrative: json(blocks) },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "document.narrative_edited",
        targetType: "Document",
        targetId: id,
        summary: `Edited the narrative of ${doc.title}`,
        before: { blocks: (doc.narrative as unknown[]).length },
        after: { blocks: blocks.length },
      },
      tx,
    );
  });
}

export {
  briefMetrics,
  CUSTOMER_SAFE_KEYS,
  RENEWAL_BRIEF_KEYS,
  type BriefFacts,
  type BriefKey,
} from "./renewal-brief";
export {
  attachBrief,
  createRenewalBrief,
  getRenewalBrief,
  loadBriefFacts,
  type BriefPage,
} from "./renewal-brief.service";
