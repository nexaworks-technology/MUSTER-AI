"use server";

import { revalidatePath } from "next/cache";
import {
  invitationIdInput,
  inviteInput,
  membershipIdInput,
  updateMembershipInput,
} from "../schemas";
import {
  createInvitation,
  deactivateMembership,
  revokeInvitation,
  updateMembership,
} from "../service";
import { actorOrRedirect, formObject, toFormError, type FormState } from "./shared";

const USERS_PATH = "/settings/users";

export async function inviteMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    const input = inviteInput.parse(formObject(formData));
    await createInvitation(actor, input);
    revalidatePath(USERS_PATH);
    return { ok: `Invitation sent to ${input.email}.` };
  } catch (error) {
    return toFormError(error);
  }
}

export async function updateMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    await updateMembership(actor, updateMembershipInput.parse(formObject(formData)));
    revalidatePath(USERS_PATH);
    return { ok: "Saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function deactivateMemberAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    const { membershipId } = membershipIdInput.parse(formObject(formData));
    await deactivateMembership(actor, membershipId);
    revalidatePath(USERS_PATH);
    return { ok: "Member deactivated." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function revokeInvitationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    const { invitationId } = invitationIdInput.parse(formObject(formData));
    await revokeInvitation(actor, invitationId);
    revalidatePath(USERS_PATH);
    return { ok: "Invitation revoked." };
  } catch (error) {
    return toFormError(error);
  }
}
