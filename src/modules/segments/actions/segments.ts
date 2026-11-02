"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { createSegment, filterFromListQuery } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

const input = z.object({
  name: z.string(),
  q: z.string().optional(),
  tier: z.string().optional(),
  stage: z.string().optional(),
  owner: z.string().optional(),
});

/** "Save as segment" on the Accounts list: the current filters become a saved segment. */
export async function saveSegmentFromListAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const values = input.parse(
      Object.fromEntries([...formData.entries()].filter(([, v]) => v !== "")),
    );
    const filter = filterFromListQuery(values);
    if (!filter) return { error: "Choose at least one filter before saving a segment." };
    const segment = await createSegment(actor, { name: values.name, filter });
    revalidatePath("/accounts");
    return { ok: `Saved segment "${segment.name}".` };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "Check the segment name." };
    if (error instanceof ForbiddenError) return { error: "You can't save segments." };
    if (
      error instanceof Error &&
      (error.name === "SegmentError" || error.name === "SegmentPermissionError")
    )
      return { error: error.message };
    logger.error({ err: error }, "save segment failed");
    return { error: "The segment was not saved. Try again." };
  }
}
