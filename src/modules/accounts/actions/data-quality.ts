"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import {
  applyDataQualityFixes,
  dismissDataQualityIssue,
  runDataQualityScan,
} from "../data-quality-service";

const PAGE = "/settings/data-quality";

async function actor() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  return ctx;
}

export async function scanAction() {
  const r = await runDataQualityScan(await actor());
  revalidatePath(PAGE);
  redirect(`${PAGE}?scanned=${r.found}` as Route);
}

/** Bound to the issue id on the page (a function formAction cannot carry name/value). */
export async function dismissAction(issueId: string) {
  const id = z.string().min(1).parse(issueId);
  await dismissDataQualityIssue(await actor(), id);
  revalidatePath(PAGE);
  redirect(PAGE as Route);
}

/** The Confirm button posts back exactly the previewed ids and versions, with confirm=true. */
export async function applyAction(formData: FormData) {
  const items = z
    .array(z.object({ id: z.string(), version: z.string() }))
    .parse(JSON.parse(String(formData.get("items") ?? "[]")));
  const result = await applyDataQualityFixes(await actor(), {
    confirm: formData.get("confirm") === "true",
    items,
  });
  revalidatePath(PAGE);
  redirect(`${PAGE}?fixed=${result.applied.length}&skipped=${result.skipped.length}` as Route);
}
