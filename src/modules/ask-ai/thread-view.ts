import { scopedDb } from "@/lib/db/scoped";
import { loadApprovalCard, type AskApprovalCard } from "./cards";
import { threadAttachmentIds } from "./files";
import { getThread } from "./loop";
import type { AskActor } from "./tools";

/**
 * Everything the /ask thread page shows, loaded as the viewer with a fixed number of queries per
 * thread (thread, messages, runs, attachment links, files) plus one approval load per proposal.
 */
export interface ThreadMessageView {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: Date;
  run: { id: string; status: string; confidence: number | null } | null;
  citations: Array<{ label: string; href: string | null }>;
  cards: AskApprovalCard[];
}

export async function loadThreadView(actor: AskActor, threadId: string) {
  const { thread, messages, runs } = await getThread(actor, threadId);
  const ids = await threadAttachmentIds(actor, thread.id);
  const files = ids.length
    ? await scopedDb(actor).fileObject.findMany({
        where: { id: { in: ids }, uploadedByMembershipId: actor.membershipId },
        select: { id: true, filename: true, scanStatus: true },
      })
    : [];
  const views: ThreadMessageView[] = [];
  for (const m of messages) {
    const run = m.agentRunId ? runs.get(m.agentRunId) : undefined;
    const effects = (m.toolCalls as { effects?: Array<{ type: string; id: string }> } | null)
      ?.effects;
    const cards =
      run?.status === "SUCCEEDED" && Array.isArray(effects)
        ? await Promise.all(
            effects.filter((e) => e.type === "Approval").map((e) => loadApprovalCard(actor, e.id)),
          )
        : [];
    const citations = Array.isArray(m.citations)
      ? (m.citations as Array<{ label?: string; href?: string | null }>).map((c) => ({
          label: c.label ?? "Source",
          href: c.href ?? null,
        }))
      : [];
    views.push({
      id: m.id,
      role: m.role as "USER" | "ASSISTANT",
      content: m.content,
      createdAt: m.createdAt,
      run: run ? { id: run.id, status: run.status, confidence: run.confidence } : null,
      citations,
      cards,
    });
  }
  return {
    thread,
    messages: views,
    files: files.map((f) => ({ id: f.id, name: f.filename, scanned: f.scanStatus === "CLEAN" })),
  };
}
