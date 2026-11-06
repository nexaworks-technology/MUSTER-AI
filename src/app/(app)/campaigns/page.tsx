import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listCampaigns } from "@/modules/campaigns/service";

export const metadata: Metadata = { title: "Campaigns" };

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const STATUS_BADGES: Record<string, BadgeVariant> = {
  DRAFT: "warning",
  SCHEDULED: "accent",
  SENDING: "accent",
  SENT: "success",
  CANCELLED: "neutral",
};

export default async function CampaignsPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const campaigns = await listCampaigns(ctx);
  const canCreate = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-section">
      {/* Subnav Tabs */}
      <div className="border-border border-b">
        <div className="flex gap-4">
          <Link
            href={"/plays" as Route}
            className="text-muted-foreground hover:text-foreground border-b-2 border-transparent pb-3 text-sm font-medium"
          >
            Plays
          </Link>
          <Link
            href={"/campaigns" as Route}
            className="text-foreground border-primary border-b-2 pb-3 text-sm font-medium"
          >
            Campaigns
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
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
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No campaigns yet. Create a campaign to send paced outbound messages to a segment.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((camp) => (
            <Card key={camp.id} className="flex flex-col justify-between">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={STATUS_BADGES[camp.status] ?? "neutral"}>{camp.status}</Badge>
                  <span className="text-muted-foreground text-xs">
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
                <div className="text-muted-foreground space-y-1 text-xs">
                  <div>Segment: {camp.segment.name}</div>
                  <div>Subject: {camp.subject}</div>
                  <div>Pace: {camp.pacePerHour}/hr</div>
                </div>
              </CardHeader>
              <CardContent className="text-muted-foreground border-t pt-0 pt-3 text-xs">
                Created {new Date(camp.createdAt).toLocaleDateString()}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
