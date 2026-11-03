-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SLACK');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('HUBSPOT', 'SALESFORCE', 'STRIPE', 'CHARGEBEE', 'SLACK');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('FULL', 'INCREMENTAL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('NIGHTLY', 'MANUAL', 'SETUP');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterEnum
ALTER TYPE "DataQualityKind" ADD VALUE 'CONFLICT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordSource" ADD VALUE 'HUBSPOT';
ALTER TYPE "RecordSource" ADD VALUE 'SALESFORCE';
ALTER TYPE "RecordSource" ADD VALUE 'STRIPE';
ALTER TYPE "RecordSource" ADD VALUE 'CHARGEBEE';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "fieldSources" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "fieldSources" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP';

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "credentialsEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalAccountId" TEXT,
    "writeBackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "writeBackFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedByMembershipId" TEXT,
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastErrorPlain" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "runKey" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "cursorIn" TEXT,
    "cursor" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "counts" JSONB NOT NULL DEFAULT '{}',
    "errorPlain" TEXT,
    "errorDetailRef" TEXT,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadStorageKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorPlain" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackUserLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_id_key" ON "Integration"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_provider_key" ON "Integration"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "SyncJob_workspaceId_integrationId_startedAt_idx" ON "SyncJob"("workspaceId", "integrationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_workspaceId_id_key" ON "SyncJob"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_workspaceId_integrationId_runKey_key" ON "SyncJob"("workspaceId", "integrationId", "runKey");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_workspaceId_id_key" ON "WebhookEvent"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_workspaceId_integrationId_externalEventId_key" ON "WebhookEvent"("workspaceId", "integrationId", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackUserLink_workspaceId_id_key" ON "SlackUserLink"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SlackUserLink_workspaceId_integrationId_slackUserId_key" ON "SlackUserLink"("workspaceId", "integrationId", "slackUserId");

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_connectedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "connectedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackUserLink" ADD CONSTRAINT "SlackUserLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackUserLink" ADD CONSTRAINT "SlackUserLink_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackUserLink" ADD CONSTRAINT "SlackUserLink_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Tenant isolation (Rule 2, ARCHITECTURE §7.1) ───────────────────────────────────────
ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Integration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Integration"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "SyncJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SyncJob"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WebhookEvent"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "SlackUserLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SlackUserLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SlackUserLink"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- A disconnected integration keeps no credentials (Rule 9): disconnect wipes them.
ALTER TABLE "Integration" ADD CONSTRAINT integration_disconnected_no_credentials
  CHECK ("status" <> 'DISCONNECTED' OR "credentialsEnc" IS NULL);
-- Write-back fields can only be listed while write-back is on (Rule 7).
ALTER TABLE "Integration" ADD CONSTRAINT integration_writeback_fields_need_switch
  CHECK ("writeBackEnabled" OR cardinality("writeBackFields") = 0);

-- Inbound calls carry no session, so the URL or payload names the integration. These read-only
-- policies admit exactly one row, named by a transaction-local setting (the Invitation pattern):
-- a webhook URL's integration id, or a Slack team id for interactivity.
CREATE POLICY integration_webhook_read ON "Integration" FOR SELECT
  USING ("id" = current_setting('app.webhook_integration_id', true));
CREATE POLICY integration_slack_team_read ON "Integration" FOR SELECT
  USING ("provider" = 'SLACK' AND "externalAccountId" = current_setting('app.slack_team_id', true));
