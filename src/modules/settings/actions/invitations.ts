"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth/config";
import { requireSession, setActiveWorkspace } from "@/lib/auth/session";
import { acceptAsNewUserInput } from "../schemas";
import { acceptInvitationAsExistingUser, acceptInvitationAsNewUser } from "../service";
import { formObject, toFormError, type FormState } from "./shared";

/** New person: create the account from the invite, then sign them straight in. */
export async function acceptInviteAsNewUserAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
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
