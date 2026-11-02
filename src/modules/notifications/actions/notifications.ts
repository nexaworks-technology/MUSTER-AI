"use server";

import { revalidatePath } from "next/cache";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { markAllRead } from "../service";

export async function markAllReadAction(): Promise<void> {
  const actor = await resolveWorkspaceContext(await requireSession());
  if (!actor) return;
  await markAllRead(actor);
  revalidatePath("/", "layout");
}
