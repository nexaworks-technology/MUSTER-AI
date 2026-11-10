import type { Metadata, Route } from "next";
import Link from "next/link";
import { MeetingsIndexView } from "@/components/app/meetings-index";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listMeetingsIndex } from "@/modules/meetings/service";

export const metadata: Metadata = { title: "Meetings & QBRs" };

/** Meetings & QBRs (spec §5): meetings from connected calendars and the QBRs already drafted. */
export default async function MeetingsPage() {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const index = await listMeetingsIndex(ctx);
  const canCreateQbr = Boolean(can(ctx, "accounts:edit"));
  return (
    <div className="space-y-section" data-testid="meetings-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Meetings &amp; QBRs</h1>
          <p className="text-muted-foreground text-sm">
            Meetings with their pre-call briefs and call summaries, and the business reviews already
            drafted. Only accounts in your book are listed.
          </p>
        </div>
        {canCreateQbr ? (
          <Button asChild>
            <Link href={"/meetings/qbr/new" as Route}>Generate a QBR</Link>
          </Button>
        ) : null}
      </div>
      <MeetingsIndexView index={index} tz={ctx.workspace.timezone} />
    </div>
  );
}
