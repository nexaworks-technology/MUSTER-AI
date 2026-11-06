"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth/config";
import { requireSession, setActiveWorkspace } from "@/lib/auth/session";
import { acceptAsNewUserInput } from "../schemas";
import { acceptInvitationAsExistingUser, acceptInvitationAsNewUser } from "../service";
import { formObject, toFormError, type FormState } from "./shared";
import { actionIp, refuseAction } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";

/** M12 A9: invitation links are tokens; accepting is limited per IP. */
async function inviteRefusal(): Promise<FormState | null> {
  const ip = await actionIp();
  const refused = await refuseAction(ip, [[`invite:ip:${ip}`, LIMITS.invitationPerIp]]);
  return refused ? { error: refused } : null;
}

/** New person: create the account from the invite, then sign them straight in. */
export async function acceptInviteAsNewUserAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const refusal = await inviteRefusal();
  if (refusal) return refusal;
  let email: string;
  let password: string;
  try {
    const input = acceptAsNewUserInput.parse(formObject(formData));
    const { user } = await acceptInvitationAsNewUser(input);
    email = user.email;
    password = input.password;
  } catch (error) {
    return toFormError(error);
  }
  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/sign-in");
    throw error; // Next's redirect on success
  }
  return {};
}

/** Existing account, already signed in with the invited email. */
export async function acceptInviteAsExistingUserAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const refusal = await inviteRefusal();
  if (refusal) return refusal;
  const session = await requireSession();
  try {
    const { membership } = await acceptInvitationAsExistingUser(
      String(formData.get("token") ?? ""),
      session.user,
    );
    await setActiveWorkspace(session, membership.workspaceId);
  } catch (error) {
    return toFormError(error);
  }
  redirect("/");
}
