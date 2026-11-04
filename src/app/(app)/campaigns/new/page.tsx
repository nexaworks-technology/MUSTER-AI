import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { createCampaignAction } from "@/modules/campaigns/actions/campaigns";
import { listSegments } from "@/modules/segments/service";

export const metadata: Metadata = { title: "New Campaign" };

export default async function NewCampaignPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "plays:createDraft")) notFound();

  const segments = await listSegments(ctx);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <div className="mb-2">
          <Link
            href={"/campaigns" as Route}
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Back to Campaigns
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">New Email Campaign</h1>
        <p className="text-muted-foreground text-sm">
          Compose an outbound campaign to send to a defined customer segment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Campaign Details</CardTitle>
          <CardDescription className="text-xs">
            All campaigns require approval from an Admin or CS Leader before scheduling.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createCampaignAction} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="name" className="text-xs">Campaign Name</Label>
              <Input
                id="name"
                name="name"
                required
                placeholder="e.g. Q4 Executive Product Update"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="segmentId" className="text-xs">Target Segment</Label>
              <select
                id="segmentId"
                name="segmentId"
                required
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="">Select a segment...</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="subject" className="text-xs">Subject Line</Label>
              <Input
                id="subject"
                name="subject"
                required
                placeholder="e.g. Important update regarding {{account.name}}"
              />
              <p className="text-[11px] text-muted-foreground">
                Placeholders: <code>{"{{account.name}}"}</code>, <code>{"{{contact.first_name}}"}</code>, <code>{"{{contact.name}}"}</code>
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="body" className="text-xs">Email Message Body</Label>
              <Textarea
                id="body"
                name="body"
                required
                rows={8}
                placeholder="Hi {{contact.first_name}},&#10;&#10;We are writing to share an update..."
              />
              <p className="text-[11px] text-muted-foreground">
                An unsubscribe link will be automatically appended to each outbound email.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="pacePerHour" className="text-xs">Delivery Pace (emails per hour)</Label>
              <Input
                id="pacePerHour"
                name="pacePerHour"
                type="number"
                defaultValue={100}
                min={1}
                max={5000}
              />
              <p className="text-[11px] text-muted-foreground">
                Default: 100 emails/hr. Pacing spaces out delivery evenly to protect domain reputation.
              </p>
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" asChild>
                <Link href={"/campaigns" as Route}>Cancel</Link>
              </Button>
              <Button type="submit">Create Campaign Draft</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
