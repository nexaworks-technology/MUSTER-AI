import { z } from "zod";
import { getQueue } from "@/lib/jobs/queues";
import type { TenantContext } from "@/lib/db/scoped";
import { runAgent, type Trigger } from "./executor";
import { getAgent } from "./registry";

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
