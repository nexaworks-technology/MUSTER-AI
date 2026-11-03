"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth/config";

export interface SignInState {
  error?: string;
}

export async function signInWithPassword(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/today",
    });
    return {};
  } catch (error) {
    // signIn() signals success by throwing Next's redirect; only Auth.js errors are failures.
    if (error instanceof AuthError)
      return { error: "That email and password don't match an account." };
    throw error;
  }
}

export async function signInWithGoogle(): Promise<void> {
  await signIn("google", { redirectTo: "/today" });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/sign-in" });
}
