import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import {
  runCampaignBatchAction,
  scheduleCampaignAction,
} from "@/modules/campaigns/actions/campaigns";
import { getCampaign } from "@/modules/campaigns/service";

export const metadata: Metadata = { title: "Campaign Details" };

const RECIPIENT_VARIANTS: Record<string, "success" | "warning" | "danger"> = {
  SENT: "success",
  HELD: "warning",
  FAILED: "danger",
  BOUNCED: "danger",
};

interface CampaignDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function CampaignDetailPage({ params }: CampaignDetailPageProps) {
  const { id } = await params;
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  let campaign;
  try {
    campaign = await getCampaign(ctx, id);
  } catch {
    notFound();
  }

  const isApproved =
    campaign.approval?.status === "APPROVED" || campaign.approval?.status === "EDITED_APPROVED";
  const canDecideApproval = ctx.role === "ADMIN" || ctx.role === "CS_LEADER";
  const canManage = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-section">
      <div>
        <div className="mb-2">
          <Link
            href={"/campaigns" as Route}
            className="text-muted-foreground text-xs hover:underline"
          >
            ← Back to Campaigns
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
            <p className="text-muted-foreground text-sm">
              Target Segment: <strong>{campaign.segment.name}</strong> • Created by{" "}
              {campaign.createdBy?.user.name ?? "System"}
            </p>
          </div>
          <div className="flex gap-2">
            {canManage && campaign.status === "SCHEDULED" && (
              <form
                action={async () => {
                  "use server";
                  await runCampaignBatchAction(campaign.id);
                }}
              >
                <Button type="submit" variant="default">
                  Run Next Batch
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Total Audience</CardDescription>
            <CardTitle className="text-xl font-bold">{campaign.stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Queued</CardDescription>
            <CardTitle className="text-foreground text-xl font-bold">
              {campaign.stats.queued}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Sent</CardDescription>
            <CardTitle className="text-success text-xl font-bold">{campaign.stats.sent}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Held by Guards</CardDescription>
            <CardTitle className="text-warning text-xl font-bold">{campaign.stats.held}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Failed / Bounced</CardDescription>
            <CardTitle className="text-danger text-xl font-bold">{campaign.stats.failed}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Governance & Schedule Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Approval & Schedule Governance</CardTitle>
          <CardDescription className="text-xs">
            Per spec §6J2, campaigns require Admin or CS Leader approval before dispatch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted border-border flex flex-col justify-between gap-4 rounded-md border p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-medium">
                Approval Status:{" "}
                <span className="text-primary font-semibold">
                  {campaign.approval?.status ?? "NONE"}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {campaign.approval?.decidedBy
                  ? `Decided by ${campaign.approval.decidedBy.user.name}`
                  : "Requires decision in Approvals queue by Admin or CS Leader."}
              </p>
            </div>
            {campaign.approval && campaign.approval.status === "PENDING" && canDecideApproval && (
              <Button asChild size="sm">
                <Link href={"/approvals" as Route}>Go to Approvals Queue</Link>
              </Button>
            )}
          </div>

          {isApproved && campaign.status === "DRAFT" && canManage && (
            <div className="border-border space-y-3 rounded-md border p-4">
              <div className="text-sm font-medium">Schedule Campaign</div>
              <p className="text-muted-foreground text-xs">
                Set the delivery start date and time. Recipient send timestamps will be spaced at{" "}
                {campaign.pacePerHour} emails/hour.
              </p>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const dt = formData.get("scheduledAt")?.toString() ?? "";
                  await scheduleCampaignAction(campaign.id, dt);
                }}
                className="flex items-center gap-3"
              >
                <Input
                  type="datetime-local"
                  name="scheduledAt"
                  required
                  defaultValue={new Date().toISOString().slice(0, 16)}
                  className="w-auto"
                />
                <Button type="submit" size="sm">
                  Schedule Delivery
                </Button>
              </form>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Template Preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message Template</CardTitle>
          <CardDescription className="text-xs">
            Exact template reviewed and frozen at approval time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground text-xs font-medium">Subject:</span>
            <div className="mt-0.5 font-medium">{campaign.subject}</div>
          </div>
          <div>
            <span className="text-muted-foreground text-xs font-medium">Body:</span>
            <div className="bg-muted mt-1 rounded-md p-4 font-mono text-xs whitespace-pre-wrap">
              {campaign.body}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recipient Audience List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients ({campaign.recipients.length})</CardTitle>
          <CardDescription className="text-xs">
            Showing first 50 audience members and per-recipient guard results.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="surface overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="font-medium">Contact</th>
                  <th className="font-medium">Account</th>
                  <th className="font-medium">Status</th>
                  <th className="font-medium">Scheduled For</th>
                  <th className="font-medium">Notes / Held Reason</th>
                </tr>
              </thead>
              <tbody>
                {campaign.recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">
                      {r.contact.name}
                      <span className="text-muted-foreground block text-xs font-normal">
                        {r.contact.email}
                      </span>
                    </td>
                    <td>{r.account.name}</td>
                    <td>
                      <Badge variant={RECIPIENT_VARIANTS[r.status] ?? "warning"}>{r.status}</Badge>
                    </td>
                    <td className="text-muted-foreground">
                      {r.scheduledFor ? new Date(r.scheduledFor).toLocaleString() : "Immediate"}
                    </td>
                    <td className="text-muted-foreground max-w-xs truncate">
                      {r.heldReason ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
