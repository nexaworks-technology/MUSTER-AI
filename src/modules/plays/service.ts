import { randomUUID } from "node:crypto";
import type { PlayStatus, Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { requirePermission, can } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { compileSegment } from "@/modules/segments/dsl";
import { checkDeadPlay, type DeadPlayResult } from "./dead-play";
import {
  playDefinitionSchema,
  type PlayBranch,
  type PlayCondition,
  type PlayDefinition,
  type PlayStepDefinition,
} from "./definition";
import { enterPlay } from "./runner";
import { validatePlaySafety, type SafetyCheckResult } from "./safety";

export class PlayNotFoundError extends Error {
  constructor(message = "Play not found") {
    super(message);
    this.name = "PlayNotFoundError";
  }
}

export type PublishResult =
  | { status: "PUBLISHED"; playId: string; versionId: string; version: number; enteredCount?: number }
  | { status: "REFUSED"; refusals: string[]; stepRefusals?: Record<string, string[]> };

export function plainLanguageSummary(def: PlayDefinition): string {
  const parts: string[] = [];

  // Trigger
  switch (def.trigger.type) {
    case "signal":
      parts.push(`Trigger: Signal "${def.trigger.ruleKey}"`);
      break;
    case "event":
      parts.push(`Trigger: Event "${def.trigger.eventType}"`);
      break;
    case "schedule":
      parts.push(`Trigger: Schedule "${def.trigger.cron}"`);
      break;
    case "segmentEntry":
      parts.push(`Trigger: Segment Entry (${def.trigger.segmentId})`);
      break;
    case "noteTag":
      parts.push(`Trigger: Note Tag "#${def.trigger.tag}"`);
      break;
  }

  // Conditions
  if (def.conditions && def.conditions.length > 0) {
    const condStrs = def.conditions.map((c) => {
      const val = Array.isArray(c.value) ? c.value.join(", ") : String(c.value ?? "");
      return `${c.field} ${c.op} ${val}`;
    });
    parts.push(`Conditions: ${condStrs.join(" AND ")}`);
  }

  const formatStep = (s: PlayStepDefinition): string => {
    switch (s.handler) {
      case "notify":
        return `Notify (${s.name}): "${(s.params as any)?.message ?? ""}"`;
      case "task":
        return `Assign task "${s.name}": "${(s.params as any)?.title ?? s.name}"`;
      case "draft":
        return `Draft email: "${(s.params as any)?.templateSubject ?? s.name}" (${(s.params as any)?.mode ?? "agent"})`;
      case "send":
        return `Send email: "${(s.params as any)?.templateSubject ?? s.name}"`;
      case "wait":
        return `Wait ${(s.params as any)?.days ?? (s.params as any)?.durationDays ?? 1} day(s)`;
      case "escalate":
        return `Escalate to CS Leader: "${(s.params as any)?.reason ?? s.name}"`;
      case "update":
        return `Update account ${(s.params as any)?.field ?? ""}`;
      case "exit":
        return `Exit play (${(s.params as any)?.reason ?? "normal"})`;
      default:
        return `${s.handler}: ${s.name}`;
    }
  };

  if (def.steps && def.steps.length > 0) {
    parts.push("Main Steps:");
    for (const [idx, s] of def.steps.entries()) {
      parts.push(`  ${idx + 1}. ${formatStep(s)}`);
    }
  }

  if (def.branches && def.branches.length > 0) {
    for (const b of def.branches) {
      const tierLabel = b.tier ?? "Default";
      parts.push(`Branch for ${tierLabel} accounts:`);
      for (const [idx, s] of (b.steps ?? []).entries()) {
        parts.push(`  ${idx + 1}. ${formatStep(s)}`);
      }
    }
  }

  return parts.join("\n");
}

export async function previewRetroactiveAccounts(
  actor: Actor,
  playId: string,
): Promise<{ count: number; accountIds: string[] }> {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!play) throw new PlayNotFoundError();
  const latestVersion = play.versions[0];
  if (!latestVersion) return { count: 0, accountIds: [] };

  const def = playDefinitionSchema.parse(latestVersion.definition);
  const accountIds: string[] = [];

  if (def.trigger.type === "signal") {
    const signals = await db.signal.findMany({
      where: {
        workspaceId: actor.workspaceId,
        ruleKey: def.trigger.ruleKey,
        status: "OPEN",
      },
      select: { accountId: true },
      distinct: ["accountId"],
    });
    accountIds.push(...signals.map((s) => s.accountId));
  } else if (def.trigger.type === "segmentEntry") {
    const seg = await db.segment.findUnique({
      where: { id: def.trigger.segmentId },
    });
    if (seg) {
      const where = compileSegment(seg.filter as any, {
        workspaceId: actor.workspaceId,
        bookScope: "ALL",
        canViewRevenue: actor.canViewRevenue,
      });
      const accounts = await db.account.findMany({
        where: { ...where, workspaceId: actor.workspaceId, archivedAt: null },
        select: { id: true },
      });
      accountIds.push(...accounts.map((a) => a.id));
    }
  } else if (def.trigger.type === "noteTag") {
    const notes = await db.note.findMany({
      where: {
        workspaceId: actor.workspaceId,
        tags: { has: def.trigger.tag },
      },
      select: { accountId: true },
      distinct: ["accountId"],
    });
    accountIds.push(...notes.map((n) => n.accountId));
  }

  return { count: accountIds.length, accountIds };
}

export async function publishPlay(
  actor: Actor,
  playId: string,
  opts: { retroactive?: boolean } = {},
): Promise<PublishResult> {
  requirePermission(actor, "plays:publish");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!play) throw new PlayNotFoundError();

  const latestVersion = play.versions[0];
  if (!latestVersion) {
    throw new Error("Play has no versions to publish.");
  }

  const def = playDefinitionSchema.parse(latestVersion.definition);

  const safety = await validatePlaySafety(def, {
    resolveSegment: async (segmentId) => {
      const seg = await db.segment.findUnique({ where: { id: segmentId } });
      return seg ? { id: seg.id, filter: seg.filter } : null;
    },
  });

  if (!safety.passed) {
    // Save the safety check results; play remains DRAFT
    await db.playVersion.update({
      where: { id: latestVersion.id },
      data: { safetyCheck: { passed: false, refusals: safety.refusals } },
    });
    return {
      status: "REFUSED",
      refusals: safety.refusals,
      stepRefusals: safety.stepRefusals,
    };
  }

  // Publish succeeded
  const now = new Date();
  await db.$tenantTransaction(async (tx) => {
    await tx.playVersion.update({
      where: { id: latestVersion.id },
      data: {
        publishedById: actor.membershipId,
        publishedAt: now,
        safetyCheck: { passed: true, refusals: [] },
      },
    });

    await tx.play.update({
      where: { id: play.id },
      data: {
        status: "PUBLISHED",
        currentVersionId: latestVersion.id,
      },
    });
  });

  // D4: Retroactive entry opt-in
  let enteredCount = 0;
  if (opts.retroactive) {
    const preview = await previewRetroactiveAccounts(actor, playId);
    for (const accountId of preview.accountIds) {
      let signalId: string | null = null;
      if (def.trigger.type === "signal") {
        const sig = await db.signal.findFirst({
          where: {
            workspaceId: actor.workspaceId,
            accountId,
            ruleKey: def.trigger.ruleKey,
            status: "OPEN",
          },
          select: { id: true },
        });
        signalId = sig?.id ?? null;
      }

      const res = await enterPlay(
        { workspaceId: actor.workspaceId },
        {
          workspaceId: actor.workspaceId,
          playId: play.id,
          accountId,
          triggerRef: `retroactive:${play.id}:v${latestVersion.version}:${accountId}`,
          signalId,
          isRetroactive: true,
        },
      );
      if (res.status === "RUNNING" || res.status === "COMPLETED") {
        enteredCount++;
      }
    }
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "play.published",
    targetType: "Play",
    targetId: play.id,
    summary: opts.retroactive
      ? `Published play "${play.name}" v${latestVersion.version} (retroactive: ${enteredCount} accounts entered)`
      : `Published play "${play.name}" v${latestVersion.version}`,
    after: {
      version: latestVersion.version,
      playVersionId: latestVersion.id,
      retroactive: Boolean(opts.retroactive),
      enteredCount: opts.retroactive ? enteredCount : undefined,
    },
  });

  return {
    status: "PUBLISHED",
    playId: play.id,
    versionId: latestVersion.id,
    version: latestVersion.version,
    enteredCount: opts.retroactive ? enteredCount : undefined,
  };
}

export async function pausePlay(actor: Actor, playId: string) {
  requirePermission(actor, "plays:publish");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({ where: { id: playId } });
  if (!play) throw new PlayNotFoundError();

  return await db.$tenantTransaction(async (tx) => {
    const updated = await tx.play.update({
      where: { id: playId },
      data: { status: "PAUSED" },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "play.paused",
        targetType: "Play",
        targetId: play.id,
        summary: `Paused play "${play.name}"`,
      },
      tx,
    );

    return updated;
  });
}

export async function killPlay(actor: Actor, playId: string) {
  requirePermission(actor, "plays:publish");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({ where: { id: playId } });
  if (!play) throw new PlayNotFoundError();

  return await db.$tenantTransaction(async (tx) => {
    const updated = await tx.play.update({
      where: { id: playId },
      data: { status: "KILLED" },
    });

    // Exit any active runs
    await tx.playRun.updateMany({
      where: {
        workspaceId: actor.workspaceId,
        playId,
        status: { in: ["RUNNING", "WAITING"] },
      },
      data: {
        status: "EXITED",
        exitReason: "Play killed",
        exitedAt: new Date(),
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "play.killed",
        targetType: "Play",
        targetId: play.id,
        summary: `Killed play "${play.name}"`,
      },
      tx,
    );

    return updated;
  });
}

export async function duplicatePlay(
  actor: Actor,
  playId: string,
  options?: { name?: string },
) {
  requirePermission(actor, "plays:createDraft");
  const db = scopedDb(actor);

  const source = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!source) throw new PlayNotFoundError();
  const latestVersion = source.versions[0];
  if (!latestVersion) throw new Error("Source play has no versions.");

  const suffix = randomUUID().slice(0, 6);
  const newKey = `${source.key}-copy-${suffix}`;
  const newName = options?.name ?? `Copy of ${source.name}`;

  return await db.$tenantTransaction(async (tx) => {
    const newPlay = await tx.play.create({
      data: {
        workspaceId: actor.workspaceId,
        key: newKey,
        name: newName,
        description: source.description,
        category: source.category,
        status: "DRAFT",
        isSeeded: false,
      },
    });

    const newVersion = await tx.playVersion.create({
      data: {
        workspaceId: actor.workspaceId,
        playId: newPlay.id,
        version: 1,
        definition: latestVersion.definition as Prisma.InputJsonValue,
      },
    });

    await tx.play.update({
      where: { id: newPlay.id },
      data: { currentVersionId: newVersion.id },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "play.duplicated",
        targetType: "Play",
        targetId: newPlay.id,
        summary: `Duplicated play "${source.name}" to "${newPlay.name}"`,
        after: {
          sourcePlayId: source.id,
          newPlayId: newPlay.id,
          key: newPlay.key,
        },
      },
      tx,
    );

    return newPlay;
  });
}

export async function revertPlayVersion(
  actor: Actor,
  playId: string,
  targetVersion: number,
) {
  requirePermission(actor, "plays:createDraft");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: { orderBy: { version: "desc" } },
    },
  });
  if (!play) throw new PlayNotFoundError();

  const target = play.versions.find((v) => v.version === targetVersion);
  if (!target) {
    throw new Error(`Version ${targetVersion} not found for this play.`);
  }

  const latestVersionNumber = play.versions[0]?.version ?? 0;
  const nextVersionNumber = latestVersionNumber + 1;

  return await db.$tenantTransaction(async (tx) => {
    const newVersion = await tx.playVersion.create({
      data: {
        workspaceId: actor.workspaceId,
        playId: play.id,
        version: nextVersionNumber,
        definition: target.definition as Prisma.InputJsonValue,
      },
    });

    await tx.play.update({
      where: { id: play.id },
      data: {
        currentVersionId: newVersion.id,
        status: "DRAFT",
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "play.version_reverted",
        targetType: "Play",
        targetId: play.id,
        summary: `Reverted play "${play.name}" to definition from v${targetVersion} (created v${nextVersionNumber})`,
        after: {
          targetVersion,
          newVersion: nextVersionNumber,
          versionId: newVersion.id,
        },
      },
      tx,
    );

    return newVersion;
  });
}

export async function listPlays(
  actor: Actor,
  query?: { status?: PlayStatus; category?: string },
) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const plays = await db.play.findMany({
    where: {
      workspaceId: actor.workspaceId,
      ...(query?.status ? { status: query.status } : {}),
      ...(query?.category ? { category: query.category } : {}),
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        include: { publishedBy: { include: { user: { select: { name: true, email: true } } } } },
      },
      _count: {
        select: {
          runs: true,
        },
      },
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });

  return plays.map((p) => {
    const latestVersion = p.versions[0];
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      category: p.category,
      status: p.status,
      isSeeded: p.isSeeded,
      version: latestVersion?.version ?? 1,
      publishedAt: latestVersion?.publishedAt ?? null,
      publishedBy: latestVersion?.publishedBy?.user.name ?? latestVersion?.publishedBy?.user.email ?? null,
      totalRuns: p._count.runs,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

export async function getPlay(actor: Actor, playId: string) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: {
        orderBy: { version: "desc" },
        include: {
          publishedBy: { include: { user: { select: { name: true, email: true } } } },
        },
      },
      runs: {
        orderBy: { enteredAt: "desc" },
        take: 20,
        include: {
          account: { select: { id: true, name: true, tier: true } },
          stepRuns: { orderBy: { createdAt: "asc" } },
        },
      },
      _count: {
        select: { runs: true },
      },
    },
  });
  if (!play) throw new PlayNotFoundError();

  const latestVersion = play.versions[0];
  const definition = latestVersion ? playDefinitionSchema.parse(latestVersion.definition) : null;
  const summary = definition ? plainLanguageSummary(definition) : "";

  return {
    ...play,
    latestVersion,
    definition,
    summary,
    totalRuns: play._count.runs,
  };
}

export async function getPlayResults(actor: Actor, playId: string) {
  requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: {
        orderBy: { version: "desc" },
      },
      currentVersion: true,
      runs: {
        orderBy: { enteredAt: "desc" },
        include: {
          account: {
            select: { id: true, name: true, tier: true, arrMinor: true },
          },
          stepRuns: {
            orderBy: { createdAt: "asc" },
          },
        },
      },
      _count: {
        select: { runs: true },
      },
    },
  });
  if (!play) throw new PlayNotFoundError();

  const publishedAt =
    play.currentVersion?.publishedAt ??
    play.versions.find((v) => v.publishedAt)?.publishedAt ??
    null;
  const lastEntryAt = play.runs[0]?.enteredAt ?? null;

  const deadPlayStatus = checkDeadPlay({
    status: play.status,
    publishedAt,
    lastEntryAt,
    totalEntries: play.runs.length,
  });

  const uniqueAccountIds = new Set(play.runs.map((r) => r.accountId));

  const allStepRuns = play.runs.flatMap((r) =>
    r.stepRuns.map((sr) => ({
      ...sr,
      accountName: r.account.name,
      accountId: r.accountId,
      accountTier: r.account.tier,
      playRunStatus: r.status,
    })),
  );

  const skips = allStepRuns
    .filter((sr) => sr.status === "SKIPPED")
    .map((sr) => {
      const res = sr.result as Record<string, unknown> | null;
      const skipReason =
        (typeof res?.skippedReason === "string" && res.skippedReason) ||
        (typeof res?.reason === "string" && res.reason) ||
        "Unknown frequency cap or safety condition";
      return {
        id: sr.id,
        playRunId: sr.playRunId,
        stepKey: sr.stepKey,
        skipReason,
        accountId: sr.accountId,
        accountName: sr.accountName,
        createdAt: sr.createdAt,
      };
    });

  const completedSteps = allStepRuns.filter(
    (sr) => sr.status === "COMPLETED" || (sr.status as string) === "AUTO_RECORDED",
  );
  const waitingSteps = allStepRuns.filter(
    (sr) => sr.status === "WAITING_APPROVAL",
  );

  const moneyVisible = Boolean(can(actor, "revenue:view"));
  const totalArrProtectedMinor = Array.from(uniqueAccountIds).reduce(
    (acc, accId) => {
      const run = play.runs.find((r) => r.accountId === accId);
      return acc + (run?.account.arrMinor ? BigInt(run.account.arrMinor) : 0n);
    },
    0n,
  );

  return {
    play: {
      id: play.id,
      key: play.key,
      name: play.name,
      description: play.description,
      status: play.status,
      category: play.category,
      isSeeded: play.isSeeded,
      version: play.currentVersion?.version ?? play.versions[0]?.version ?? 1,
      publishedAt,
    },
    deadPlayStatus,
    stats: {
      totalRuns: play.runs.length,
      openRuns: play.runs.filter((r) => r.status === "RUNNING" || r.status === "WAITING_APPROVAL").length,
      completedRuns: play.runs.filter((r) => r.status === "COMPLETED").length,
      exitedRuns: play.runs.filter((r) => r.status === "EXITED").length,
      accountsEntered: uniqueAccountIds.size,
      actionsTaken: completedSteps.length,
      skipsCount: skips.length,
      waitingApprovals: waitingSteps.length,
      revenueProtectedMinor: moneyVisible ? totalArrProtectedMinor : null,
    },
    runs: play.runs.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountName: r.account.name,
      accountTier: r.account.tier,
      status: r.status,
      triggerRef: r.triggerRef,
      enteredAt: r.enteredAt,
      completedAt: r.completedAt,
      exitedAt: r.exitedAt,
      exitReason: r.exitReason,
      stepCount: r.stepRuns.length,
      stepRuns: r.stepRuns,
    })),
    skips,
  };
}
