"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { systemClock } from "@/lib/dates";
import { logger } from "@/lib/logger";
import { enqueueBacktest, enqueueWorkspaceRun } from "@/modules/signals/service";
import { activateModel, previewModelEdit, saveModelEdit } from "../service";

export interface ModelActionState {
  ok?: string;
  error?: string;
  preview?: {
    sentence: string;
    caught: number;
    churns: number;
    falseAlarms: number;
    renewals: number;
    meanLead: number | null;
    medianLead: number | null;
  };
}

const PILLAR_FIELDS = [
  "ADOPTION",
  "ENGAGEMENT",
  "SUPPORT",
  "RELATIONSHIP",
  "COMMERCIAL",
  "SENTIMENT",
] as const;

async function actor() {
  return resolveWorkspaceContext(await requireSession());
}

function fail(error: unknown, what: string): ModelActionState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "That isn't valid." };
  if (error instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  if (error instanceof Error && ["ModelActivationError"].includes(error.name))
    return { error: error.message };
  if (error instanceof Error && /Run the back-test first/.test(error.message))
    return { error: error.message };
  logger.error({ err: error }, `${what} failed`);
  return { error: "That did not work. Try again." };
}

/** Weights are typed as percentages (they must add up to 100). */
function editFromForm(fd: FormData) {
  const pct = (k: string) => Number(fd.get(k));
  return {
    basedOnId: String(fd.get("basedOnId") ?? ""),
    weights: Object.fromEntries(
      PILLAR_FIELDS.map((p) => [p, Math.round(pct(`w.${p}`) * 100) / 10_000]),
    ),
    thresholds: { healthyMin: pct("healthyMin"), watchMin: pct("watchMin") },
    note: String(fd.get("note") ?? "") || undefined,
  };
}

export async function runBacktestAction(_prev: ModelActionState): Promise<ModelActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    requirePermission(a, "healthModel:propose");
    await enqueueBacktest(a);
    revalidatePath("/settings/health-model");
    return { ok: "Back-test started. It takes a few seconds; refresh to see the proposal." };
  } catch (error) {
    return fail(error, "back-test");
  }
}

/** Preview (no save) or save as a new draft version. */
export async function modelEditAction(
  _prev: ModelActionState,
  fd: FormData,
): Promise<ModelActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const edit = editFromForm(fd);
    if (fd.get("intent") === "save") {
      const draft = await saveModelEdit(a, edit, systemClock);
      revalidatePath("/settings/health-model");
      return {
        ok: `Saved as draft v${draft.version}. Nothing changes until an Admin activates it.`,
      };
    }
    const p = await previewModelEdit(a, edit);
    return {
      preview: {
        sentence: p.sentence,
        caught: p.result.caught,
        churns: p.result.churns,
        falseAlarms: p.result.falseAlarms,
        renewals: p.result.renewals,
        meanLead: p.result.meanLeadDays,
        medianLead: p.result.medianLeadDays,
      },
    };
  } catch (error) {
    return fail(error, "model edit");
  }
}

export async function activateModelAction(
  _prev: ModelActionState,
  fd: FormData,
): Promise<ModelActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const m = await activateModel(a, z.string().min(1).parse(fd.get("modelId")));
    // New snapshots under the new version; existing snapshots keep the version that made them.
    await enqueueWorkspaceRun(a);
    revalidatePath("/settings/health-model");
    revalidatePath("/health");
    return {
      ok: `Health model v${m.version} is active. Every account is being re-scored with it.`,
    };
  } catch (error) {
    return fail(error, "activate model");
  }
}
