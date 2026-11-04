-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('QUEUED', 'HELD', 'SENT', 'FAILED', 'BOUNCED');

-- AlterTable Approval: make accountId nullable and add CHECK constraint
ALTER TABLE "Approval" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "Approval" ADD CONSTRAINT approval_campaign_account_null
  CHECK (("kind" = 'CAMPAIGN') OR ("accountId" IS NOT NULL));

-- CreateTable Campaign
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "pacePerHour" INTEGER NOT NULL DEFAULT 100,
    "approvalId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable CampaignRecipient
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "outboundMessageId" TEXT,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "heldReason" TEXT,
    "guardResults" JSONB NOT NULL DEFAULT '[]',
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- AlterTable OutboundMessage
ALTER TABLE "OutboundMessage" ADD COLUMN "campaignId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_id_key" ON "Campaign"("workspaceId", "id");
CREATE UNIQUE INDEX "Campaign_approvalId_key" ON "Campaign"("approvalId");
CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_workspaceId_approvalId_key" ON "Campaign"("workspaceId", "approvalId");
CREATE INDEX "Campaign_workspaceId_status_scheduledAt_idx" ON "Campaign"("workspaceId", "status", "scheduledAt");

CREATE UNIQUE INDEX "CampaignRecipient_workspaceId_id_key" ON "CampaignRecipient"("workspaceId", "id");
CREATE UNIQUE INDEX "CampaignRecipient_workspaceId_campaignId_contactId_key" ON "CampaignRecipient"("workspaceId", "campaignId", "contactId");
CREATE INDEX "CampaignRecipient_workspaceId_status_scheduledFor_idx" ON "CampaignRecipient"("workspaceId", "status", "scheduledFor");

CREATE INDEX "OutboundMessage_workspaceId_campaignId_idx" ON "OutboundMessage"("workspaceId", "campaignId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_segmentId_fkey" FOREIGN KEY ("workspaceId", "segmentId") REFERENCES "Segment"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_approvalId_fkey" FOREIGN KEY ("workspaceId", "approvalId") REFERENCES "Approval"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_createdById_fkey" FOREIGN KEY ("workspaceId", "createdById") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_outboundMessageId_fkey" FOREIGN KEY ("workspaceId", "outboundMessageId") REFERENCES "OutboundMessage"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS & Force RLS
ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Campaign" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Campaign" FOR ALL USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "CampaignRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignRecipient" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CampaignRecipient" FOR ALL USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
