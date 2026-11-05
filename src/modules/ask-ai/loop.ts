import type { Prisma } from "@prisma/client";
import { type AgentRun } from "@prisma/client";
import { z } from "zod";
import {
  AiNotConfiguredError,
  getAiProvider,
  isAiConfigured,
  loadPrompt,
  renderPrompt,
  type AiProvider,
} from "@/lib/ai";
import { writeAudit } from "@/lib/audit";
import { scopedDb } from "@/lib/db/scoped";
import type { AskAiOutput, ExecutorDeps } from "@/modules/agents/service";
import { threadAttachmentIds } from "./files";
import { ASK_TOOLS, runAskTool, type AskActor, type AskRecord } from "./tools";

/**
 * Ask AI's question loop (M11 S10, D-159). Code, not the model, runs the tools:
 *   1. the question is stored as the asker's message in their thread (threads are owner-only);
 *   2. up to MAX_STEPS planning calls (`ask-ai-plan` prompt) each return tool calls or "answer";
 *      code runs every call through `runAskTool` AS THE ASKER and feeds the records back;
 *   3. the answer is ONE AgentRun of the `ask-ai` agent whose input names the retrieval steps
 *      (its bundle is rebuilt from them as the asker), validated by the shared evaluator;
 *   4. the assistant message stores the run id, the citations (with labels/links) and the steps.
 * An answer that did not pass validation is stored with its run but is never rendered.
 */
export const MAX_STEPS = 6;
const MAX_CALLS = 24;

export class AskThreadNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "AskThreadNotFoundError";
  }
}

export class AskFileNotInThreadError extends Error {
  constructor() {
    super("That file is not attached to this conversation");
    this.name = "AskFileNotInThreadError";
  }
}

const planOutput = z.object({
  action: z.enum(["call", "answer"]),
  calls: z
    .array(
      z.object({ tool: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}) }),
    )
    .max(4)
    .default([]),
});

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const toolCatalogue = () =>
  ASK_TOOLS.map(
    (t) => `- ${t.name}: ${t.description} Input: ${JSON.stringify(z.toJSONSchema(t.input))}`,
  ).join("\n");

export interface AskResult {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  status: AgentRun["status"] | "NOT_CONFIGURED";
  runId: string | null;
}

/** Owner-only: a thread exists for this member, in this workspace, or it does not exist. */
async function ownThread(actor: AskActor, threadId: string) {
  const t = await scopedDb(actor).askThread.findFirst({
    where: { id: threadId, membershipId: actor.membershipId },
  });
  if (!t) throw new AskThreadNotFoundError();
  return t;
}

export async function listThreads(actor: AskActor) {
  return scopedDb(actor).askThread.findMany({
    where: { membershipId: actor.membershipId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  });
}

export async function getThread(actor: AskActor, threadId: string) {
  const thread = await ownThread(actor, threadId);
  const db = scopedDb(actor);
  const messages = await db.askMessage.findMany({
    where: { threadId: thread.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const runIds = messages.flatMap((m) => (m.agentRunId ? [m.agentRunId] : []));
  const runs = runIds.length
    ? await db.agentRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, status: true, confidence: true, output: true, effects: true },
      })
    : [];
  return { thread, messages, runs: new Map(runs.map((r) => [r.id, r])) };
}

export async function askQuestion(
  actor: AskActor,
  raw: { question: string; threadId?: string; fileIds?: string[] },
  deps: ExecutorDeps & { promptsDir?: string } = {},
): Promise<AskResult> {
  const { question, threadId, fileIds } = z
    .object({
      question: z.string().trim().min(1).max(2000),
      threadId: z.string().min(1).optional(),
      fileIds: z.array(z.string().min(1).max(64)).max(10).optional(),
    })
    .parse(raw);
  const db = scopedDb(actor);
  if (fileIds?.length && !threadId) throw new AskFileNotInThreadError();
  const thread = threadId
    ? await ownThread(actor, threadId)
    : await db.askThread.create({
        data: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          membershipId: actor.membershipId,
          title: question.slice(0, 120),
        },
      });
  // Attached files must be this asker's own and bound to THIS thread; the planner is told their ids.
  let attachedFiles: Array<{ fileId: string; fileName: string; scanned: boolean }> = [];
  if (fileIds?.length) {
    const linked = new Set(await threadAttachmentIds(actor, thread.id));
    if (fileIds.some((f) => !linked.has(f))) throw new AskFileNotInThreadError();
    const rows = await db.fileObject.findMany({
      where: {
        id: { in: fileIds },
        purpose: "ASK_ATTACHMENT",
        uploadedByMembershipId: actor.membershipId,
      },
      select: { id: true, filename: true, scanStatus: true },
    });
    if (rows.length !== new Set(fileIds).size) throw new AskFileNotInThreadError();
    attachedFiles = rows.map((r) => ({
      fileId: r.id,
      fileName: r.filename,
      scanned: r.scanStatus === "CLEAN",
    }));
  }
  const earlier = await db.askMessage.findMany({
    where: { threadId: thread.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { role: true, content: true, agentRunId: true },
  });
  const userMessage = await db.askMessage.create({
    data: { workspaceId: actor.workspaceId, threadId: thread.id, role: "USER", content: question },
  });
  if (!deps.provider && !isAiConfigured())
    return {
      threadId: thread.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: "NOT_CONFIGURED",
      runId: null,
    };
  const provider: AiProvider = deps.provider ?? getAiProvider();
  const history = earlier.reverse().map((m) => ({ role: m.role, text: m.content }));

  // ── Retrieval: code runs every tool the planner asks for, as the asker ────────────────────────
  const plan = await loadPrompt("ask-ai-plan", "1.0.0", deps.promptsDir);
  const system = renderPrompt(plan.body, {
    question,
    history: history.map((h) => `${h.role}: ${h.text}`).join("\n") || "(none)",
    tools: toolCatalogue(),
  });
  const steps: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const results: Array<{
    tool: string;
    input: unknown;
    records: AskRecord[];
    notFound: string | null;
  }> = [];
  const planning: Array<{
    step: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }> = [];
  for (let step = 1; step <= MAX_STEPS && steps.length < MAX_CALLS; step++) {
    let res;
    try {
      res = await provider.generateStructured({
        tier: "deep",
        workspaceId: actor.workspaceId,
        promptRef: plan.ref,
        system,
        input: JSON.stringify({
          step,
          ...(attachedFiles.length ? { attachedFiles } : {}),
          results: results.map((r) => ({
            tool: r.tool,
            input: r.input,
            notFound: r.notFound,
            records: r.records.map((x) => ({ ref: x.ref, label: x.label, fields: x.fields })),
          })),
        }),
        schema: planOutput,
      });
    } catch (e) {
      if (e instanceof AiNotConfiguredError) break; // answer from what was retrieved
      throw e;
    }
    planning.push({
      step,
      calls: res.output?.calls.length ?? 0,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });
    if (!res.output || res.output.action === "answer" || res.output.calls.length === 0) break;
    for (const call of res.output.calls.slice(0, MAX_CALLS - steps.length)) {
      steps.push({ tool: call.tool, input: call.input });
      try {
        const out = await runAskTool(actor, call.tool, call.input);
        results.push({
          tool: call.tool,
          input: call.input,
          records: out.records,
          notFound: out.notFound,
        });
      } catch {
        results.push({
          tool: call.tool,
          input: call.input,
          records: [],
          notFound: `The tool ${call.tool} could not run with that input.`,
        });
      }
    }
  }

  // Loaded on use: the ask-ai agent definition imports this module's tools (no load-time cycle).
  const { askAi, runAgent } = await import("@/modules/agents/service");
  // ── Answer: one validated AgentRun ──────────────────────────────────────────────────────────
  const outcome = await runAgent(
    actor,
    askAi,
    {
      question,
      membershipId: actor.membershipId,
      threadId: thread.id,
      messageId: userMessage.id,
      history,
      retrieval: steps,
    },
    { type: "AskMessage", id: userMessage.id },
    { ...deps, provider },
  );
  if (outcome.kind === "not_configured")
    return {
      threadId: thread.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: "NOT_CONFIGURED",
      runId: null,
    };
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: outcome.runId } });
  const out = run.status === "SUCCEEDED" ? (run.output as unknown as AskAiOutput) : null;
  const byRef = new Map(results.flatMap((r) => r.records).map((r) => [`${r.type}:${r.id}`, r]));
  const citations = (out?.citations ?? []).map((c) => {
    const rec = byRef.get(`${c.sourceType}:${c.sourceId}`);
    return { ...c, label: rec?.label ?? c.sourceType, href: rec?.href ?? null };
  });
  const assistant = await db.$tenantTransaction(async (tx) => {
    const m = await tx.askMessage.create({
      data: {
        workspaceId: actor.workspaceId,
        threadId: thread.id,
        role: "ASSISTANT",
        // Only a validated answer is stored as text; otherwise a plain system sentence (no AI text).
        content: out?.answer ?? "I could not answer that with sources I can show you.",
        agentRunId: run.id,
        citations: json(citations),
        toolCalls: json({ steps, planning, effects: run.effects ?? [] }),
      },
    });
    await tx.askThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "ask.answered",
        targetType: "AskMessage",
        targetId: m.id,
        agentRunId: run.id,
        summary: `Ask AI ${run.status === "SUCCEEDED" ? "answered" : `did not answer (${run.status.toLowerCase()})`} after ${steps.length} tool call${steps.length === 1 ? "" : "s"}`,
      },
      tx,
    );
    return m;
  });
  return {
    threadId: thread.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistant.id,
    status: run.status,
    runId: run.id,
  };
}
