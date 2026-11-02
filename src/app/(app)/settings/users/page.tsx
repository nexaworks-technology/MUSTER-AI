import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/modules/settings/schemas";
import { listMembers, listPendingInvitations } from "@/modules/settings/service";
import { InviteForm } from "./invite-form";
import { MemberRow } from "./member-row";
import { RevokeButton } from "./revoke-button";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const [members, invitations] = await Promise.all([listMembers(ctx), listPendingInvitations(ctx)]);
  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Invite someone</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <InviteForm />
        </CardContent>
      </Card>

      <section aria-labelledby="members-heading" className="space-y-2">
        <h2 id="members-heading" className="text-base font-semibold">
          Members ({members.filter((m) => m.status === "ACTIVE").length} active)
        </h2>
        <ul>
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={{
                membershipId: m.id,
                name: m.user.name ?? m.user.email,
                email: m.user.email,
                role: m.role,
                bookScope: m.bookScope,
                canViewRevenue: m.canViewRevenue,
                active: m.status === "ACTIVE",
                isYou: m.userId === ctx.userId,
              }}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="invites-heading" className="space-y-2">
        <h2 id="invites-heading" className="text-base font-semibold">
          Pending invitations
        </h2>
        {invitations.length === 0 ? (
          <p className="text-muted-foreground text-sm">No pending invitations.</p>
        ) : (
          <ul>
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="border-border flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"
              >
                <span>
                  {inv.email} · {ROLE_LABELS[inv.role]} · expires{" "}
                  {inv.expiresAt.toLocaleDateString("en-US", { dateStyle: "medium" })}
                </span>
                <RevokeButton invitationId={inv.id} email={inv.email} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
