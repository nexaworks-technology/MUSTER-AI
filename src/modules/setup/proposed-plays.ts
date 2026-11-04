import type { Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";
import { writeAudit } from "@/lib/audit";
import type { Actor } from "@/modules/accounts/service";
import { SEEDED_PLAYS, type SeededPlay } from "@/modules/plays/service";

export interface WorkspaceSetupData {
  connectedProviders: string[];
  hasAccounts: boolean;
  hasContracts: boolean;
  hasTiers: boolean;
  hasOnboarding: boolean;
}

export interface ProposedPlay {
  playKey: string;
  name: string;
  category: string;
  reason: string;
}

/**
 * Deterministically proposes plays based on workspace integration and lifecycle state.
 * Strictly NO LLM is used (spec §6O1, D9).
 * Dormant plays are NEVER proposed.
 */
export function proposePlaysForWorkspace(data: WorkspaceSetupData): ProposedPlay[] {
  const proposals: ProposedPlay[] = [];
  const providersUpper = (data.connectedProviders || []).map((p) => p.toUpperCase());

  const hasBilling = providersUpper.includes("STRIPE") || providersUpper.includes("CHARGEBEE");
  const hasCrm = providersUpper.includes("HUBSPOT") || providersUpper.includes("SALESFORCE");

  // Lookup table of live seeded plays only
  const liveSeeded = new Map<string, SeededPlay>();
  for (const p of SEEDED_PLAYS) {
    if (!p.isDormant) {
      liveSeeded.set(p.key, p);
    }
  }

  const add = (key: string, reason: string) => {
    const play = liveSeeded.get(key);
    if (play && !proposals.some((p) => p.playKey === key)) {
      proposals.push({
        playKey: play.key,
        name: play.name,
        category: play.category,
        reason,
      });
    }
  };

  // 1. Core Risk & Health (baseline for all workspaces with accounts)
  if (data.hasAccounts) {
    add("health-risk", "Core safety net to detect and remediate account health drops.");
    add("champion-loss", "Alerts when a key contact leaves or a power user becomes quiet.");
  }

  // 2. Billing & Payment Failure
  if (hasBilling) {
    add("payment-failed", "Triggered automatically when a connected billing provider reports a failed payment.");
  }

  // 3. Renewals & Contracts
  if (data.hasContracts || hasCrm) {
    add("renewal-risk", "Proactively identifies high-risk accounts approaching their contract renewal date.");
    add("renewal-window", "Coordinates milestone review and outreach when an account enters its renewal window.");
  }

  // 4. Onboarding & Handoff
  if (data.hasOnboarding) {
    add("onboarding-stall", "Detects stalled implementations and alerts the CSM to unblock onboarding.");
    add("customer-handoff", "Coordinates post-sales kickoff tasks and welcome communications.");
  }

  // 5. Adoption & Expansion
  if (data.hasTiers || data.hasAccounts) {
    add("adoption-drop", "Monitors feature adoption drops and dispatches engagement plays.");
    add("expansion-opportunity", "Identifies accounts with strong usage signals ready for tier expansion.");
  }

  // 6. Support & Retention
  if (data.hasAccounts) {
    add("support-escalation", "Escalates serious or urgent customer support tickets to the account owner.");
    add("cancellation-save", "Triggered by cancellation risk notes to coordinate immediate retention outreach.");
  }

  return proposals;
}

/**
 * Creates the selected proposed plays as DRAFT plays in the workspace database.
 * Each proposed play lands as DRAFT and faces the normal publish gate (safety.ts).
 */
export async function applyProposedPlaysToWorkspace(
  actor: Actor,
  selectedKeys: string[],
): Promise<number> {
  const db = scopedDb(actor);
  const existing = await db.play.findMany({
    where: { workspaceId: actor.workspaceId },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((p) => p.key));

  let createdCount = 0;
  for (const key of selectedKeys) {
    if (existingKeys.has(key)) continue;

    const playDef = SEEDED_PLAYS.find((p) => p.key === key && !p.isDormant);
    if (!playDef) continue;

    await db.$tenantTransaction(async (tx) => {
      const play = await tx.play.create({
        data: {
          workspaceId: actor.workspaceId,
          key: playDef.key,
          name: playDef.name,
          description: playDef.description,
          category: playDef.category,
          status: "DRAFT",
          isSeeded: true,
        },
      });

      await tx.playVersion.create({
        data: {
          workspaceId: actor.workspaceId,
          playId: play.id,
          version: 1,
          definition: playDef.definition as unknown as Prisma.InputJsonValue,
        },
      });

      await writeAudit(
        {
          workspaceId: actor.workspaceId,
          actorType: "USER",
          actorId: actor.userId,
          action: "setup.play_proposed",
          targetType: "Play",
          targetId: play.id,
          summary: `Created proposed play draft "${playDef.name}" during setup`,
          after: { key: playDef.key, status: "DRAFT" },
        },
        tx,
      );
    });

    createdCount++;
  }

  return createdCount;
}
