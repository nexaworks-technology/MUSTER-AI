import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { getOwnWorkspace, markWorkspaceLive, markWorkspacePending } from "@/lib/db/workspace";
import { scopedDb } from "@/lib/db/scoped";
import { getQueue } from "@/lib/jobs/queues";
import { applyTierRule, type Actor } from "@/modules/accounts/service";
import { listModels } from "@/modules/health/service";
import { listIntegrations } from "@/modules/integrations/service";
import { createSegment, listSegments, type SegmentFilter } from "@/modules/segments/service";
import { getSettingsData } from "@/modules/settings/service";
import { backtestRunning } from "@/modules/signals/service";
import {
  applyProposedPlaysToWorkspace,
  proposePlaysForWorkspace,
} from "./proposed-plays";

export { applyProposedPlaysToWorkspace, proposePlaysForWorkspace };
export type { ProposedPlay } from "./proposed-plays";

/**
 * The setup wizard (spec §6O1, M5 §2): Connect → Import → Tiers and segments → Health model →
 * Proposed plays → Go live. Admin only. Every step reads real data and writes through the owning
 * module; the proposed health model and its back-test sentence come from the M3 deterministic engine
 * (no LLM number). Going live clears `setupPending`, so the workspace gets its nightly run.
 */
export const SETUP_STEPS = ["connect", "import", "tiers", "health", "plays", "live"] as const;
const KEPT_DEFAULT = "health_model.default_kept";
export type SetupStep = (typeof SETUP_STEPS)[number];

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

function admin(actor: Actor) {
  requirePermission(actor, "workspace:manageSettings");
  requirePermission(actor, "integrations:manage");
}

/** What each step shows. */
export async function getSetupState(actor: Actor) {
  admin(actor);
  const db = scopedDb(actor);
  const [
    workspace,
    integrations,
    accounts,
    contacts,
    contracts,
    tiers,
    settings,
    segments,
    models,
    backtesting,
    imports,
    onboardingCount,
    existingPlays,
    unownedAccounts,
  ] = await Promise.all([
    getOwnWorkspace(actor),
    listIntegrations(actor),
    db.account.count({ where: { archivedAt: null } }),
    db.contact.count(),
    db.contract.count(),
    db.account.groupBy({ by: ["tier"], _count: { _all: true }, where: { archivedAt: null } }),
    getSettingsData(actor.workspaceId),
    listSegments(actor),
    listModels(actor),
    backtestRunning(actor),
    db.importJob.count({ where: { status: "COMPLETED" } }),
    db.account.count({ where: { lifecycleStage: "ONBOARDING", archivedAt: null } }),
    db.play.findMany({ select: { key: true, name: true, status: true } }),
    db.account.count({ where: { archivedAt: null, ownerMembershipId: null } }),
  ]);
  const active = models.find((m) => m.status === "ACTIVE") ?? null;
  const proposal =
    models.find(
      (m) =>
        m.proposedBy === "BACKTEST_PROPOSAL" &&
        m.status === "DRAFT" &&
        (!active?.activatedAt || m.createdAt > active.activatedAt),
    ) ?? null;

  const connectedList = integrations.filter(
    (c) => c.integration && c.integration.status !== "DISCONNECTED",
  );
  const proposedPlays = proposePlaysForWorkspace({
    connectedProviders: connectedList.map((c) => c.provider),
    hasAccounts: accounts > 0,
    hasContracts: contracts > 0,
    hasTiers: tiers.length > 0,
    hasOnboarding: onboardingCount > 0,
  });

  // Kept for THIS proposal only: a later back-test asks again.
  const keptDefault = proposal
    ? (await db.auditLog.count({
        where: { action: KEPT_DEFAULT, targetType: "HealthModel", targetId: proposal.id },
      })) > 0
    : false;
  return {
    setupPending: workspace.setupPending,
    baseCurrency: workspace.baseCurrency,
    connected: connectedList,
    counts: { accounts, contacts, contracts, importsDone: imports, unownedAccounts },
    tierRule: settings.tierRule,
    tierCounts: Object.fromEntries(tiers.map((t) => [t.tier, t._count._all])) as Partial<
      Record<string, number>
    >,
    segments: segments.map((s) => s.name),
    health: {
      active: active
        ? { version: active.version, sentence: active.backtest?.sentence ?? null }
        : null,
      proposal: proposal
        ? {
            id: proposal.id,
            version: proposal.version,
            sentence: proposal.backtest?.sentence ?? null,
            /** The engine's own words when the history is too thin to trust the numbers. */
            caveat:
              proposal.backtest && !proposal.backtest.sufficient
                ? (proposal.backtest.reason ?? null)
                : null,
          }
        : null,
      backtesting,
      /** The Admin kept the default because the history was too thin to back-test (D-96). */
      keptDefault,
    },
    plays: {
      proposed: proposedPlays,
      existing: existingPlays,
    },
  };
}

export async function applyProposedPlays(actor: Actor, playKeys: string[]) {
  admin(actor);
  return await applyProposedPlaysToWorkspace(actor, playKeys);
}

export const tierRuleInput = z
  .object({
    highTouchMinArr: z.coerce.number().int("Use whole amounts").positive("Use an amount above 0"),
    midTouchMinArr: z.coerce.number().int("Use whole amounts").positive("Use an amount above 0"),
  })
  .refine((v) => v.highTouchMinArr > v.midTouchMinArr, {
    message: "The high-touch amount must be above the mid-touch amount.",
  });

/** Saves the ARR tier bands (INTERP-3) and re-tiers every account whose tier follows the rule. */
export async function saveTierRule(actor: Actor, raw: unknown) {
  admin(actor);
  const input = tierRuleInput.parse(raw);
  const db = scopedDb(actor);
  const before = (await getSettingsData(actor.workspaceId)).tierRule;
  const row = await db.workspaceSettings.findUnique({ where: { workspaceId: actor.workspaceId } });
  const data = { ...((row?.data as Record<string, unknown> | null) ?? {}), tierRule: input };
  const ruled = await db.account.findMany({ where: { tierSource: "RULE" }, select: { id: true } });
  await db.$tenantTransaction(async (tx) => {
    await tx.workspaceSettings.upsert({
      where: { workspaceId: actor.workspaceId },
      create: { workspaceId: actor.workspaceId, data },
      update: { data },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "settings.tier_rule_changed",
        targetType: "Workspace",
        targetId: actor.workspaceId,
        summary: `Tier bands set: high-touch from ${input.highTouchMinArr}, mid-touch from ${input.midTouchMinArr} (${ruled.length} accounts follow the rule)`,
        before,
        after: input,
      },
      tx,
    );
  });
  // Re-tier after the new bands are committed: the tier rule reads the saved settings.
  await db.$tenantTransaction(async (tx) => {
    for (const a of ruled) await applyTierRule(tx, actor.workspaceId, a.id);
  });
}

/**
 * When the engine says the history is too thin to back-test (it refuses to activate such a
 * proposal), the Admin may keep the default model for now (D-96). Allowed only after a back-test
 * ran and reported that; recorded in the audit log, which is what Go live checks.
 */
export async function keepDefaultModel(actor: Actor) {
  admin(actor);
  const state = await getSetupState(actor);
  if (!state.health.proposal?.caveat)
    throw new SetupError(
      "Run the back-test first; keep the default only when there is not enough history.",
    );
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: KEPT_DEFAULT,
    targetType: "HealthModel",
    targetId: state.health.proposal.id,
    summary: `Kept the default health model: ${state.health.proposal.caveat}`,
  });
}

/** The default segments the wizard proposes (spec §6O1); existing names are left alone. */
export const DEFAULT_SEGMENTS: ReadonlyArray<{ name: string; filter: SegmentFilter }> = [
  {
    name: "High-touch accounts",
    filter: { all: [{ field: "tier", op: "eq", value: "HIGH_TOUCH" }] },
  },
  {
    name: "Renewing in the next 90 days",
    filter: { all: [{ field: "renewalDate", op: "withinNextDays", value: 90 }] },
  },
  {
    name: "Onboarding",
    filter: { all: [{ field: "lifecycleStage", op: "eq", value: "ONBOARDING" }] },
  },
];

export async function createDefaultSegments(actor: Actor) {
  admin(actor);
  const existing = new Set((await listSegments(actor)).map((s) => s.name));
  let created = 0;
  for (const s of DEFAULT_SEGMENTS)
    if (!existing.has(s.name)) {
      await createSegment(actor, s);
      created++;
    }
  return created;
}

/**
 * Go live: the workspace leaves setup and its nightly run is scheduled (the worker's
 * `nightly.schedules` job registers it; with NIGHTLY_SCHEDULES=off it registers nothing).
 * Needs an active health model and at least one account, so day one has a real queue.
 */
export async function goLive(actor: Actor) {
  admin(actor);
  const state = await getSetupState(actor);
  if (!state.setupPending) return { alreadyLive: true };
  if (state.counts.accounts === 0)
    throw new SetupError("Import or sync at least one account before going live.");
  // The Admin reviews the model first (§6O1): an approved back-tested model, or the default
  // explicitly kept because the back-test said the history is too thin (D-96).
  if (!state.health.active)
    throw new SetupError("Review and approve the proposed health model before going live.");
  if (!state.health.active.sentence && !state.health.keptDefault)
    throw new SetupError("Review and approve the proposed health model before going live.");
  // Compare-and-set: of two clicks at once, only the one that flips it goes on (review pass).
  if (!(await markWorkspaceLive(actor))) return { alreadyLive: true };
  try {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "workspace.went_live",
      targetType: "Workspace",
      targetId: actor.workspaceId,
      summary: `Setup finished: ${state.counts.accounts} accounts, health model v${state.health.active.version}${state.health.active.sentence ? "" : " (default kept)"}; nightly run on`,
    });
  } catch (err) {
    // Going live is never left unrecorded: put the workspace back in setup and report the failure.
    await markWorkspacePending(actor);
    throw err;
  }
  await getQueue("maintenance").add("nightly.schedules", {}, { removeOnComplete: true });
  return { alreadyLive: false, version: state.health.active.version };
}
