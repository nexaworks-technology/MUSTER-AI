"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { confirmImport, ImportError, previewImport, setMapping } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

async function run(
  jobId: string,
  fn: (actor: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceContext>>>) => Promise<string>,
): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const ok = await fn(actor);
    revalidatePath(`/settings/import/${jobId}`);
    revalidatePath("/settings/import");
    return { ok };
  } catch (error) {
    if (error instanceof ImportError) return { error: error.message };
    if (error instanceof ForbiddenError)
      return { error: "Only admins and CS leaders can import data." };
    logger.error({ err: error, jobId }, "import action failed");
    return { error: "Something went wrong. Nothing was imported." };
  }
}

/** Saves the column mapping, then runs the dry-run preview. */
export async function previewImportAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const jobId = String(formData.get("jobId") ?? "");
  const mapping = Object.fromEntries(
    [...formData.entries()]
      .filter(([k]) => k.startsWith("map:"))
      .map(([k, v]) => [k.slice(4), String(v)]),
  );
  return run(jobId, async (actor) => {
    await setMapping(actor, jobId, mapping);
    const report = await previewImport(actor, jobId);
    return `Preview ready: ${report.preview?.create ?? 0} to create, ${report.preview?.update ?? 0} to update, ${report.preview?.unchanged ?? 0} unchanged, ${report.totalErrors} with problems.`;
  });
}

export async function confirmImportAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const jobId = String(formData.get("jobId") ?? "");
  return run(jobId, async (actor) => {
    await confirmImport(actor, jobId);
    return "Import started.";
  });
}
