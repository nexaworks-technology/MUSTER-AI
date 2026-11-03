import type { AgentRun } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { can, requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { resolveProof, type ProofLink } from "@/modules/approvals/service";
import { listAgents } from "./registry";

/**
 * Settings › AI team (spec §6E intro, ARCHITECTURE §6.4): each agent with its switch, tier and
 * recent runs; each run with what it read (links), what it decided (output, reasoning, the
 * model's own confidence), what it did (effects, approvals and their decisions) and its audit row.
 */
export class AgentRunNotFoundError extends Error {
  constructor() {
    super("Agent run not found");
    this.name = "AgentRunNotFoundError";
  }
}

/** Ensures one AgentDefinition row per registered agent (enabled by default). */
async function definitions(actor: Actor) {
  const db = scopedDb(actor);
  for (const def of listAgents())
    await db.agentDefinition.upsert({
      where: { workspaceId_agentKey: { workspaceId: actor.workspaceId, agentKey: def.key } },
      create: { workspaceId: actor.workspaceId, agentKey: def.key, codeVersion: def.version },
      update: { codeVersion: def.version },
    });
  return db.agentDefinition.findMany();
}

export async function listAgentTeam(actor: Actor) {
  requirePermission(actor, "audit:view");
  const db = scopedDb(actor);
  const rows = new Map((await definitions(actor)).map((d) => [d.agentKey, d]));
  return Promise.all(
    listAgents().map(async (def) => {
      const [recent, byStatus] = await Promise.all([
        db.agentRun.findMany({
          where: { agentKey: def.key },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { account: { select: { id: true, name: true } } },
        }),
        db.agentRun.groupBy({ by: ["status"], where: { agentKey: def.key }, _count: true }),
      ]);
      return {
        key: def.key,
        description: def.description,
        version: def.version,
        tier: def.modelTier,
        tierReason: def.tierReason,
        prompt: `${def.prompt.name}@${def.prompt.version}`,
        internalOnly: def.approvalPolicy === "INTERNAL",
        enabled: rows.get(def.key)?.enabled ?? true,
        counts: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Partial<
          Record<AgentRun["status"], number>
        >,
        recent,
      };
    }),
  );
}

export const setEnabledInput = z.object({
  agentKey: z.string().min(1),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setAgentEnabled(actor: Actor, raw: unknown) {
  requirePermission(actor, "workspace:manageSettings");
  const { agentKey, enabled } = setEnabledInput.parse(raw);
  if (!listAgents().some((d) => d.key === agentKey)) throw new AgentRunNotFoundError();
  await definitions(actor);
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    await tx.agentDefinition.update({
      where: { workspaceId_agentKey: { workspaceId: actor.workspaceId, agentKey } },
      data: { enabled },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: enabled ? "agent.enabled" : "agent.disabled",
        targetType: "AgentDefinition",
        targetId: agentKey,
        summary: `${enabled ? "Switched on" : "Switched off"} the ${agentKey} agent`,
      },
      tx,
    );
  });
}

export interface RunDetail {
  run: AgentRun & { account: { id: string; name: string } | null };
  read: ProofLink[];
  did: ProofLink[];
  approvals: Array<{
    id: string;
    status: string;
    decidedAt: Date | null;
    decidedBy: string | null;
    note: string | null;
  }>;
  audit: Array<{ action: string; summary: string; createdAt: Date }>;
}

/**
 * One run, if the viewer may see it: leaders see every run; a CSM sees runs on accounts in their
 * book (the Health tab's "What it read" link). Anything else is not found (404).
 */
export async function getRunDetail(actor: Actor, runId: string): Promise<RunDetail> {
  const db = scopedDb(actor);
  const leaders = can(actor, "audit:view");
  const grant = can(actor, "accounts:view");
  const run = await db.agentRun.findFirst({
    where: {
      id: runId,
      ...(leaders ? {} : grant ? { account: bookWhere(actor, grant.scope) } : { id: "" }),
    },
    include: { account: { select: { id: true, name: true } } },
  });
  if (!run) throw new AgentRunNotFoundError();
  const refs = (x: unknown) =>
    Array.isArray(x)
      ? x.flatMap((r) =>
          r &&
          typeof r === "object" &&
          typeof r.sourceType === "string" &&
          typeof r.sourceId === "string"
            ? [{ sourceType: r.sourceType, sourceId: r.sourceId }]
            : [],
        )
      : [];
  const effects = Array.isArray(run.effects)
    ? (run.effects as Array<{ type: string; id: string }>).map((e) => ({
        sourceType: e.type,
        sourceId: e.id,
      }))
    : [];
  const accountId = run.accountId ?? "";
  const [read, did, approvals, audit] = await Promise.all([
    resolveProof(db, accountId, refs(run.inputRefs)),
    resolveProof(db, accountId, effects),
    db.approval.findMany({
      where: { proposedByAgentRunId: run.id },
      include: { decidedBy: { include: { user: { select: { name: true } } } } },
    }),
    db.auditLog.findMany({
      where: { agentRunId: run.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, summary: true, createdAt: true },
    }),
  ]);
  return {
    run,
    read,
    did,
    approvals: approvals.map((a) => ({
      id: a.id,
      status: a.status,
      decidedAt: a.decidedAt,
      decidedBy: a.decidedBy?.user.name ?? null,
      note: a.decisionNote,
    })),
    audit,
  };
}
