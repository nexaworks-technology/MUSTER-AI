import { z } from "zod";
import { getQueue } from "@/lib/jobs/queues";
import type { TenantContext } from "@/lib/db/scoped";
import { runAgent, type Trigger } from "./executor";
import { reextractPayload } from "@/modules/conversations/service";
import { backfillExtractions, reextractSources } from "./definitions/watcher";
import { processConsider, sweepHealthNarratives } from "./definitions/health-analyst-trigger";
import { getAgent } from "./registry";
import { listActiveWorkspaces } from "@/lib/db/workspace";

/**
 * The `agents.run` job (M4 §2). The payload names the workspace, the agent and its trigger; the
 * executor re-derives everything else from scoped records, so a job built for workspace A can
 * only ever read A. BullMQ's job id dedupes enqueues; the AgentRun key dedupes runs.
 */
export const agentRunPayload = z.object({
  workspaceId: z.string().min(1),
  agentKey: z.string().min(1),
  input: z.unknown(),
  trigger: z.object({ type: z.string().min(1), id: z.string().min(1) }),
});

export async function enqueueAgent(
  ctx: TenantContext,
  agentKey: string,
  input: unknown,
  trigger: Trigger,
): Promise<void> {
  const data = agentRunPayload.parse({ workspaceId: ctx.workspaceId, agentKey, input, trigger });
  await getQueue("agents").add("agents.run", data, {
    jobId: `${ctx.workspaceId}.${agentKey}.${trigger.type}.${trigger.id}`.replaceAll(":", "_"),
    // The executor retries transient provider errors itself (D-74); job attempts cover crashes.
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
  });
}

export async function processAgentRun(raw: unknown) {
  const p = agentRunPayload.parse(raw);
  return runAgent({ workspaceId: p.workspaceId }, getAgent(p.agentKey), p.input, p.trigger);
}

export { processConsider };

/** Every active workspace: consider each current snapshot that has no narrative run yet. */
export async function sweepAllHealthNarratives() {
  const out: Record<string, { considered: number; ran: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await sweepHealthNarratives({ workspaceId: w.id });
  return out;
}

/**
 * `conversations.reextract` (M9): re-read, with the current Watcher prompt, what an earlier prompt
 * version read. One job per workspace and prompt version (dedupe-intended, D-81); the payload is
 * ids and a version string only, never text (Rule 7).
 */
export async function enqueueReextract(ctx: TenantContext, promptVersion: string): Promise<void> {
  const data = reextractPayload.parse({ workspaceId: ctx.workspaceId, promptVersion });
  await getQueue("agents").add("conversations.reextract", data, {
    jobId: `${ctx.workspaceId}.conversations.reextract.${promptVersion}`.replaceAll(":", "_"),
    attempts: 2,
    backoff: { type: "exponential", delay: 30_000 },
  });
}

export async function processReextract(raw: unknown) {
  const p = reextractPayload.parse(raw);
  return reextractSources({ workspaceId: p.workspaceId }, { promptVersion: p.promptVersion });
}

/** Every active workspace: read the newest unread messages, notes and call chunks (a few per pass). */
export async function sweepAllExtractions() {
  const out: Record<string, unknown> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await backfillExtractions({ workspaceId: w.id }, { limit: 25 });
  return out;
}
