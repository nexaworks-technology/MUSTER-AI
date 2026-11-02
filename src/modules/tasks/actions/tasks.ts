"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import type { createTaskInput } from "../schemas";
import { taskIdInput } from "../schemas";
import { completeTask, createTask } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

async function ctx() {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) throw new ForbiddenError("accounts:view");
  return c;
}

function failure(error: unknown): ActionState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "Check the form and try again." };
  if (error instanceof ForbiddenError) return { error: "You can't change this." };
  if (error instanceof Error && /NotFound/.test(error.name))
    return { error: "That could not be found." };
  logger.error({ err: error }, "task action failed");
  return { error: "Something went wrong. Nothing was changed." };
}

export async function createTaskAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const task = await createTask(
      await ctx(),
      Object.fromEntries(formData) as z.input<typeof createTaskInput>,
    );
    revalidatePath("/tasks");
    if (task.accountId) revalidatePath(`/accounts/${task.accountId}/tasks`);
    return { ok: "Task created." };
  } catch (error) {
    return failure(error);
  }
}

export async function completeTaskAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { taskId } = taskIdInput.parse(Object.fromEntries(formData));
    const task = await completeTask(await ctx(), taskId);
    revalidatePath("/tasks");
    if (task.accountId) revalidatePath(`/accounts/${task.accountId}`, "layout");
    return { ok: "Done." };
  } catch (error) {
    return failure(error);
  }
}
