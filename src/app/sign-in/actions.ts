"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth/config";
import { actionIp, noteAuthFailure, refuseAction } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";

export interface SignInState {
  error?: string;
}

export async function signInWithPassword(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  // M12 A9: per-IP and per-email limits; a blocked IP (repeated failures) is refused.
  const ip = await actionIp();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const refused = await refuseAction(ip, [
    [`signin:ip:${ip}`, LIMITS.signInPerIp],
    [`signin:email:${email}`, LIMITS.signInPerEmail],
  ]);
  if (refused) return { error: refused };
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/today",
    });
    return {};
  } catch (error) {
    // signIn() signals success by throwing Next's redirect; only Auth.js errors are failures.
    if (error instanceof AuthError) {
      await noteAuthFailure(ip);
      return { error: "That email and password don't match an account." };
    }
    throw error;
  }
}

export async function signInWithGoogle(): Promise<void> {
  await signIn("google", { redirectTo: "/today" });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/sign-in" });
}
