import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { runCampaignBatchAction, scheduleCampaignAction } from "@/modules/campaigns/actions/campaigns";
import { getCampaign } from "@/modules/campaigns/service";

export const metadata: Metadata = { title: "Campaign Details" };

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
    <div className="space-y-6">
      <div>
        <div className="mb-2">
          <Link
            href={"/campaigns" as Route}
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Back to Campaigns
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{campaign.name}</h1>
            <p className="text-muted-foreground text-sm">
              Target Segment: <strong>{campaign.segment.name}</strong> • Created by{" "}
              {campaign.createdBy?.user.name ?? "System"}
            </p>
          </div>
          <div className="flex gap-2">
            {canManage && campaign.status === "SCHEDULED" && (
              <form action={runCampaignBatchAction.bind(null, campaign.id)}>
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
            <CardTitle className="text-xl font-bold text-amber-800 dark:text-amber-300">{campaign.stats.queued}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Sent</CardDescription>
            <CardTitle className="text-xl font-bold text-emerald-600">{campaign.stats.sent}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Held by Guards</CardDescription>
            <CardTitle className="text-xl font-bold text-orange-600">{campaign.stats.held}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardDescription className="text-xs">Failed / Bounced</CardDescription>
            <CardTitle className="text-xl font-bold text-rose-600">{campaign.stats.failed}</CardTitle>
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
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border rounded-md bg-muted/30">
            <div>
              <div className="text-sm font-medium">
                Approval Status:{" "}
                <span className="font-semibold text-primary">
                  {campaign.approval?.status ?? "NONE"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
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
            <div className="p-4 border rounded-md space-y-3">
              <div className="text-sm font-medium">Schedule Campaign</div>
              <p className="text-xs text-muted-foreground">
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
                <input
                  type="datetime-local"
                  name="scheduledAt"
                  required
                  defaultValue={new Date().toISOString().slice(0, 16)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
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
            <span className="font-medium text-xs text-muted-foreground">Subject:</span>
            <div className="font-medium mt-0.5">{campaign.subject}</div>
          </div>
          <div>
            <span className="font-medium text-xs text-muted-foreground">Body:</span>
            <div className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 p-4 font-mono text-xs">
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
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Scheduled For</th>
                  <th className="py-2 font-medium">Notes / Held Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {campaign.recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-4 font-medium">
                      {r.contact.name}
                      <span className="block text-[11px] text-muted-foreground font-normal">
                        {r.contact.email}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">{r.account.name}</td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          r.status === "SENT"
                            ? "bg-emerald-100 text-emerald-800"
                            : r.status === "HELD"
                              ? "bg-orange-100 text-orange-800"
                              : r.status === "FAILED"
                                ? "bg-rose-100 text-rose-800"
                                : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {r.scheduledFor ? new Date(r.scheduledFor).toLocaleString() : "Immediate"}
                    </td>
                    <td className="py-2.5 text-muted-foreground truncate max-w-xs">
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
