import type { AgentRun } from "@prisma/client";
import { isAiConfigured } from "@/lib/ai";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { resolveProof, type ProofLink } from "@/modules/approvals/service";
import { healthAnalystOutput } from "./definitions/health-analyst";

/**
 * What the Health tab may show from the Health Analyst (§6.4): only a SUCCEEDED run, each item
 * with links to the exact reasons and signals it cites. Failed, uncited or invalid runs render
 * nothing; with no API key the tab says "AI is not configured" and shows no narrative.
 */
export interface Narrative {
  configured: boolean;
  run: Pick<
    AgentRun,
    "id" | "status" | "confidence" | "finishedAt" | "model" | "promptVersion"
  > | null;
  items: Array<{ text: string; sources: ProofLink[] }>;
  missing: string[];
  reasoningSummary: string | null;
  /** The latest attempt, when it is newer than the run shown and did not succeed. */
  latestAttempt: { id: string; status: AgentRun["status"] } | null;
}

export async function healthNarrative(ctx: TenantContext, accountId: string): Promise<Narrative> {
  const db = scopedDb(ctx);
  const [run, latest] = await Promise.all([
    db.agentRun.findFirst({
      where: { accountId, agentKey: "health-analyst", status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
    }),
    db.agentRun.findFirst({
      where: { accountId, agentKey: "health-analyst" },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const base = {
    configured: isAiConfigured(),
    latestAttempt:
      latest && latest.status !== "SUCCEEDED" && (!run || latest.createdAt > run.createdAt)
        ? { id: latest.id, status: latest.status }
        : null,
  };
  if (!run) return { ...base, run: null, items: [], missing: [], reasoningSummary: null };
  const parsed = healthAnalystOutput.safeParse(run.output);
  if (!parsed.success)
    return { ...base, run: null, items: [], missing: [], reasoningSummary: null };
  const items = await Promise.all(
    parsed.data.items.map(async (i) => ({
      text: i.text,
      sources: await resolveProof(db, accountId, [
        ...i.citesReasonIds.map((id) => ({ sourceType: "HealthReason", sourceId: id })),
        ...i.citesSignalIds.map((id) => ({ sourceType: "Signal", sourceId: id })),
      ]),
    })),
  );
  return {
    ...base,
    run: {
      id: run.id,
      status: run.status,
      confidence: run.confidence,
      finishedAt: run.finishedAt,
      model: run.model,
      promptVersion: run.promptVersion,
    },
    items,
    missing: parsed.data.insufficientData?.missing ?? [],
    reasoningSummary: parsed.data.reasoningSummary,
  };
}
