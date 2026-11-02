import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext, type WorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { UserFacingError } from "../service";

export interface FormState {
  ok?: string;
  error?: string;
}

/** The signed-in user's workspace context, or a redirect to sign in. */
export async function actorOrRedirect(): Promise<WorkspaceContext> {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  return ctx;
}

/** Maps expected failures to a safe message; anything else is logged and shown generically. */
export function toFormError(error: unknown): FormState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "Check the form and try again." };
  if (error instanceof UserFacingError) return { error: error.message };
  if (error instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  logger.error({ err: error }, "settings action failed");
  return { error: "Something went wrong. Nothing was changed. Try again." };
}

export function formObject(formData: FormData): Record<string, string> {
  return Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
}
