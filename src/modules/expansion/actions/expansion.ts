"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { AccountNotFoundError } from "@/modules/accounts/service";
import { WriteBackRefusedError } from "@/modules/integrations/service";
import { exportOpportunity, ExpansionError, updateOpportunity } from "../read.service";

const PAGE = z.enum(["/expansion"]).or(z.string().regex(/^\/accounts\/[\w-]+\/expansion$/));

async function run(returnTo: string, work: () => Promise<string>) {
  const page = PAGE.parse(returnTo);
  let q: string;
  try {
    q = `ok=${encodeURIComponent(await work())}`;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof AccountNotFoundError) notFound();
    if (e instanceof ExpansionError || e instanceof WriteBackRefusedError)
      q = `error=${encodeURIComponent(e.message)}`;
    else if (e instanceof z.ZodError)
      q = `error=${encodeURIComponent(e.issues[0]?.message ?? "Check the form.")}`;
    else throw e;
  }
  revalidatePath(page);
  redirect(`${page}?${q}` as Route);
}

/** Status, next step, its date and (Admin) the owner; the service re-checks who may. */
export async function updateOpportunityAction(returnTo: string, id: string, form: FormData) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  await run(returnTo, async () => {
    const text = (k: string) => {
      const v = form.get(k);
      return v === null ? undefined : String(v);
    };
    const owner = text("owner");
    await updateOpportunity(ctx, z.string().min(1).max(60).parse(id), {
      status: text("status") || undefined,
      nextStep: text("nextStep") ?? undefined,
      nextStepDate: text("nextStepDate") === undefined ? undefined : text("nextStepDate") || null,
      ...(owner !== undefined ? { ownerMembershipId: owner || null } : {}),
    });
    return "Opportunity saved.";
  });
}

/** Asks to create the opportunity in the connected CRM; it goes through the write-back gate. */
export async function exportOpportunityAction(returnTo: string, id: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  await run(returnTo, async () => {
    const r = await exportOpportunity(ctx, z.string().min(1).max(60).parse(id));
    return `Sent for approval: it will be created in ${r.crm} once an approver agrees.`;
  });
}
