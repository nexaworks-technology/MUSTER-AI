"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { DataHealthError, retryDeadJob } from "../data-health.service";

const PAGE = "/settings/data-health";

/** Bound to one dead job on the page: runs it again (own workspace only; audited). */
export async function retryJobAction(queue: string, jobId: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  let q = "retried=1";
  try {
    await retryDeadJob(ctx, { queue, jobId });
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    if (!(e instanceof DataHealthError)) throw e;
    q = "error=gone";
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${q}` as Route);
}
