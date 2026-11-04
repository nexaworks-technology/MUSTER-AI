"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { AccountNotFoundError } from "@/modules/accounts/service";
import { categoryInput, RenewalError, setForecastCategory } from "../read.service";

/** Sets or clears the human forecast category; the service re-checks who may. */
export async function setForecastCategoryAction(
  returnTo: string,
  renewalId: string,
  form: FormData,
) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  const page = z
    .enum(["/renewals"])
    .or(z.string().regex(/^\/accounts\/[\w-]+\/renewal$/))
    .parse(returnTo);
  const raw = String(form.get("category") ?? "");
  let q: string;
  try {
    const input = categoryInput.parse({
      category: raw === "" ? null : raw,
      note: String(form.get("note") ?? "") || undefined,
    });
    await setForecastCategory(ctx, z.string().min(1).max(60).parse(renewalId), input);
    q = `ok=${encodeURIComponent(input.category ? "Forecast category saved." : "Forecast category cleared.")}`;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof AccountNotFoundError) notFound();
    if (e instanceof RenewalError) q = `error=${encodeURIComponent(e.message)}`;
    else if (e instanceof z.ZodError)
      q = `error=${encodeURIComponent(e.issues[0]?.message ?? "Check the form.")}`;
    else throw e;
  }
  revalidatePath(page);
  redirect(`${page}?${q}` as Route);
}
