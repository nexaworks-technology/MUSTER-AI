"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession, setActiveWorkspace } from "@/lib/auth/session";

export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const workspaceId = z.string().min(1).parse(formData.get("workspaceId"));
  // setActiveWorkspace refuses any workspace the user is not an active member of.
  await setActiveWorkspace(session, workspaceId);
  revalidatePath("/", "layout");
}
