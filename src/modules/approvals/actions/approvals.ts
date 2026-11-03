"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { approve, bulkDecide, editAndApprove, reject, type DecisionResult } from "../service";

/** Server Actions for the Approvals screen. Decisions are always made in the app (`via: APP`). */
export interface ApprovalActionState {
  ok?: string;
  error?: string;
  /** Set when an approved email could not be sent, with the reasons dispatch gave. */
  notSent?: string[];
}

async function actor() {
  return resolveWorkspaceContext(await requireSession());
}

function fail(error: unknown, what: string): ApprovalActionState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "That isn't valid." };
  if (error instanceof ForbiddenError)
    return { error: "You don't have permission to decide approvals." };
  if (
    error instanceof Error &&
    ["ApprovalNotFoundError", "ApprovalStateError"].includes(error.name)
  )
    return { error: error.message };
  logger.error({ err: error }, `${what} failed`);
  return { error: "Not saved. Try again." };
}

function outcome(r: DecisionResult, verb: string): ApprovalActionState {
  if (!r.send) return { ok: verb };
  if (r.send.status === "SENT")
    return { ok: `${verb}. The email was sent (${r.send.transport} transport).` };
  if (r.send.status === "ALREADY_SENT") return { ok: `${verb}. The email had already been sent.` };
  if (r.send.status === "HELD")
    return { ok: `${verb}, but the email is held: ${r.send.heldReason}` };
  return { ok: `${verb}, but the email was not sent.`, notSent: r.send.reasons };
}

const refresh = (id?: string) => {
  revalidatePath("/approvals");
  if (id) revalidatePath(`/approvals/${id}`);
  revalidatePath("/today");
};

const fields = (fd: FormData) => Object.fromEntries(fd) as Record<string, string>;

export async function approveAction(
  _prev: ApprovalActionState,
  fd: FormData,
): Promise<ApprovalActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const r = await approve(a, fields(fd));
    refresh(r.approval.id);
    return outcome(r, "Approved");
  } catch (e) {
    return fail(e, "approve");
  }
}

export async function editApproveAction(
  _prev: ApprovalActionState,
  fd: FormData,
): Promise<ApprovalActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const r = await editAndApprove(a, fields(fd));
    refresh(r.approval.id);
    return outcome(r, "Edit saved as a new version and approved");
  } catch (e) {
    return fail(e, "edit and approve");
  }
}

export async function rejectAction(
  _prev: ApprovalActionState,
  fd: FormData,
): Promise<ApprovalActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const r = await reject(a, fields(fd));
    refresh(r.approval.id);
    return { ok: "Rejected. Nothing was sent." };
  } catch (e) {
    return fail(e, "reject");
  }
}

export async function bulkAction(
  _prev: ApprovalActionState,
  fd: FormData,
): Promise<ApprovalActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const results = await bulkDecide(a, {
      decision: fd.get("decision"),
      approvalIds: fd.getAll("approvalId").map(String),
      confirmedIds: fd.getAll("confirmedId").map(String),
      note: (fd.get("note") as string | null) || undefined,
    });
    refresh();
    const notSent = results.flatMap((r) =>
      r.send && r.send.status === "NOT_SENT" ? r.send.reasons : [],
    );
    return {
      ok: `${results.length} ${fd.get("decision") === "approve" ? "approved" : "rejected"}.`,
      ...(notSent.length ? { notSent } : {}),
    };
  } catch (e) {
    return fail(e, "bulk decide");
  }
}
