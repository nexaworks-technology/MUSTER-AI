import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listCampaigns } from "@/modules/campaigns/service";

export const metadata: Metadata = { title: "Campaigns" };

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  SCHEDULED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  SENDING: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  SENT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  CANCELLED: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

export default async function CampaignsPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const campaigns = await listCampaigns(ctx);
  const canCreate = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-6">
      {/* Subnav Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-4">
          <Link
            href={"/plays" as Route}
            className="pb-3 text-sm font-medium text-muted-foreground hover:text-foreground border-b-2 border-transparent"
          >
            Plays
          </Link>
          <Link
            href={"/campaigns" as Route}
            className="pb-3 text-sm font-medium text-foreground border-b-2 border-primary"
          >
            Campaigns
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <p className="text-muted-foreground text-sm">
            Audience-targeted outbound email campaigns governed by approval gates and pacing.
          </p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href={"/campaigns/new" as Route}>New Campaign</Link>
          </Button>
        )}
      </div>

      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No campaigns yet. Create a campaign to send paced outbound messages to a segment.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((camp) => (
            <Card key={camp.id} className="flex flex-col justify-between">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGES[camp.status] ?? "bg-muted text-muted-foreground"
                    }`}
                  >
                    {camp.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {camp._count.recipients} recipients
                  </span>
                </div>
                <CardTitle className="text-base font-medium">
                  <Link
                    href={`/campaigns/${camp.id}` as Route}
                    className="hover:underline focus:outline-none"
                  >
                    {camp.name}
                  </Link>
                </CardTitle>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>Segment: {camp.segment.name}</div>
                  <div>Subject: {camp.subject}</div>
                  <div>Pace: {camp.pacePerHour}/hr</div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 text-xs text-muted-foreground border-t pt-3">
                Created {new Date(camp.createdAt).toLocaleDateString()}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
