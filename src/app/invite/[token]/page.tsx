import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PRODUCT_NAME } from "@/config/product";
import { getSession } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/modules/settings/schemas";
import { getInvitationState } from "@/modules/settings/service";
import { ExistingUserAcceptForm, NewUserAcceptForm } from "./accept-forms";

export const metadata: Metadata = { title: "Invitation" };

const ENDED = {
  invalid:
    "This invitation link isn't valid. Check that you copied the whole link, or ask for a new one.",
  expired: "This invitation has expired. Ask an admin of the workspace to send a new one.",
  used: "This invitation has already been used.",
  revoked: "This invitation was withdrawn. Ask an admin of the workspace if you still need access.",
} as const;

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [state, session] = await Promise.all([getInvitationState(token), getSession()]);

  let body;
  if (state.kind !== "pending") {
    body = (
      <>
        <p>{ENDED[state.kind]}</p>
        <Link href="/sign-in" className="text-sm underline">
          Go to sign in
        </Link>
      </>
    );
  } else if (!state.hasAccount) {
    body = <NewUserAcceptForm token={token} email={state.invitation.email} />;
  } else if (session?.user.email === state.invitation.email) {
    body = <ExistingUserAcceptForm token={token} />;
  } else {
    body = (
      <p>
        You already have an account as {state.invitation.email}.{" "}
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>{" "}
        with that email, then open this link again to accept.
      </p>
    );
  }

  const heading =
    state.kind === "pending" ? `Join ${state.invitation.workspace.name}` : "Invitation";
  const description =
    state.kind === "pending"
      ? `${state.invitation.invitedBy.user.name ?? state.invitation.invitedBy.user.email} invited you as ${ROLE_LABELS[state.invitation.role]}.`
      : PRODUCT_NAME;

  return (
    <main className="bg-muted flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg font-semibold">{heading}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">{body}</CardContent>
      </Card>
    </main>
  );
}
