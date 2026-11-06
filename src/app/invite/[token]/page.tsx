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
        <Link
          href="/sign-in"
          className="text-primary focus-visible:ring-ring rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
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
        <Link
          href="/sign-in"
          className="text-primary focus-visible:ring-ring rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2"
        >
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
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10 md:py-16">
      <Card className="w-full gap-6 py-6 md:py-8">
        <CardHeader className="px-6 md:px-8">
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-6 text-sm leading-relaxed md:px-8">{body}</CardContent>
      </Card>
    </main>
  );
}
