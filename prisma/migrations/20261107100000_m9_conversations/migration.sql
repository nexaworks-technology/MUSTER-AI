-- CreateEnum
CREATE TYPE "PromiseParty" AS ENUM ('US', 'CUSTOMER', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "PromiseStatus" AS ENUM ('OPEN', 'KEPT', 'LATE', 'BROKEN');

-- CreateEnum
CREATE TYPE "InboxSourceType" AS ENUM ('MESSAGE', 'TICKET');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('NEW', 'DRAFTED', 'REPLIED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InboxMatchedBy" AS ENUM ('SOURCE', 'CONTACT_EMAIL', 'DOMAIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "UnmatchedStatus" AS ENUM ('PENDING', 'ASSIGNED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordSource" ADD VALUE 'ZENDESK';
ALTER TYPE "RecordSource" ADD VALUE 'FRESHDESK';
ALTER TYPE "RecordSource" ADD VALUE 'GMAIL';
ALTER TYPE "RecordSource" ADD VALUE 'MICROSOFT_EMAIL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'ZENDESK';
ALTER TYPE "IntegrationProvider" ADD VALUE 'FRESHDESK';
ALTER TYPE "IntegrationProvider" ADD VALUE 'GOOGLE_EMAIL';
ALTER TYPE "IntegrationProvider" ADD VALUE 'MICROSOFT_EMAIL';

-- DropIndex
DROP INDEX "Extraction_workspaceId_sourceType_sourceId_promptVersion_it_key";

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "previousTitle" TEXT,
ADD COLUMN     "titleChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Extraction" ADD COLUMN     "chunkIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "extractionId" TEXT;

-- CreateTable
CREATE TABLE "Promise" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "party" "PromiseParty" NOT NULL,
    "suggestedParty" "PromiseParty",
    "what" TEXT NOT NULL,
    "dueDate" DATE,
    "ownerMembershipId" TEXT,
    "status" "PromiseStatus" NOT NULL DEFAULT 'OPEN',
    "statusReason" TEXT NOT NULL,
    "statusComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceType" TEXT,
    "evidenceId" TEXT,
    "keptAt" TIMESTAMP(3),
    "sourceType" "ExtractionSourceType",
    "sourceId" TEXT,
    "quote" TEXT,
    "extractionId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'HUMAN',
    "agentRunId" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceType" "InboxSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "InboxStatus" NOT NULL DEFAULT 'NEW',
    "assigneeMembershipId" TEXT,
    "draftOutboundMessageId" TEXT,
    "matchedBy" "InboxMatchedBy" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedInbound" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "RecordSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddresses" TEXT[],
    "subject" TEXT,
    "bodyText" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "candidateAccountIds" TEXT[],
    "status" "UnmatchedStatus" NOT NULL DEFAULT 'PENDING',
    "assignedAccountId" TEXT,
    "assignedMessageId" TEXT,
    "decidedByMembershipId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnmatchedInbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promise_workspaceId_accountId_status_idx" ON "Promise"("workspaceId", "accountId", "status");

-- CreateIndex
CREATE INDEX "Promise_workspaceId_status_dueDate_idx" ON "Promise"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Promise_workspaceId_id_key" ON "Promise"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Promise_workspaceId_accountId_dedupeKey_key" ON "Promise"("workspaceId", "accountId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Promise_workspaceId_extractionId_key" ON "Promise"("workspaceId", "extractionId");

-- CreateIndex
CREATE INDEX "InboxItem_workspaceId_status_receivedAt_idx" ON "InboxItem"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboxItem_workspaceId_accountId_idx" ON "InboxItem"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItem_workspaceId_id_key" ON "InboxItem"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItem_workspaceId_sourceType_sourceId_key" ON "InboxItem"("workspaceId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "UnmatchedInbound_workspaceId_status_receivedAt_idx" ON "UnmatchedInbound"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedInbound_workspaceId_id_key" ON "UnmatchedInbound"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedInbound_workspaceId_provider_externalId_key" ON "UnmatchedInbound"("workspaceId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Extraction_workspaceId_sourceType_sourceId_promptVersion_ch_key" ON "Extraction"("workspaceId", "sourceType", "sourceId", "promptVersion", "chunkIndex", "itemIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Goal_workspaceId_extractionId_key" ON "Goal"("workspaceId", "extractionId");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_extractionId_fkey" FOREIGN KEY ("workspaceId", "extractionId") REFERENCES "Extraction"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_extractionId_fkey" FOREIGN KEY ("workspaceId", "extractionId") REFERENCES "Extraction"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promise" ADD CONSTRAINT "Promise_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_workspaceId_assigneeMembershipId_fkey" FOREIGN KEY ("workspaceId", "assigneeMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_workspaceId_draftOutboundMessageId_fkey" FOREIGN KEY ("workspaceId", "draftOutboundMessageId") REFERENCES "OutboundMessage"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedInbound" ADD CONSTRAINT "UnmatchedInbound_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedInbound" ADD CONSTRAINT "UnmatchedInbound_workspaceId_assignedAccountId_fkey" FOREIGN KEY ("workspaceId", "assignedAccountId") REFERENCES "Account"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedInbound" ADD CONSTRAINT "UnmatchedInbound_workspaceId_decidedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "decidedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level security for the three new [W] tables.
ALTER TABLE "Promise" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Promise" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Promise"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "Promise" ADD CONSTRAINT promise_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

ALTER TABLE "InboxItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboxItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InboxItem"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "UnmatchedInbound" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UnmatchedInbound" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UnmatchedInbound"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));


-- Rule 1 (extraction carries its proof): a promise made by AI names its quote, its source, its
-- extraction and its run. Rule 2: a KEPT promise names the evidence and the day.
ALTER TABLE "Promise" ADD CONSTRAINT promise_ai_proof
  CHECK ("origin" <> 'AI' OR ("quote" IS NOT NULL AND "extractionId" IS NOT NULL AND "sourceId" IS NOT NULL));
ALTER TABLE "Promise" ADD CONSTRAINT promise_kept_evidence
  CHECK ("status" <> 'KEPT' OR ("keptAt" IS NOT NULL AND "evidenceType" IS NOT NULL AND "evidenceId" IS NOT NULL));

-- D2: once assigned or dismissed, the holding row keeps no copy of the text.
ALTER TABLE "UnmatchedInbound" ADD CONSTRAINT unmatched_text_cleared
  CHECK ("status" = 'PENDING' OR "bodyText" IS NULL);
ALTER TABLE "UnmatchedInbound" ADD CONSTRAINT unmatched_assigned_names_account
  CHECK ("status" <> 'ASSIGNED' OR "assignedAccountId" IS NOT NULL);

-- A goal read from text names the extraction that proves it.
ALTER TABLE "Goal" ADD CONSTRAINT goal_extraction_is_ai
  CHECK ("extractionId" IS NULL OR "origin" = 'AI');

-- Role change (M9, D-56 pattern): record when a title changed and what it was, for every writer.
CREATE FUNCTION contact_title_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."title" IS NOT NULL AND NEW."title" IS DISTINCT FROM OLD."title"
    AND NEW."titleChangedAt" IS NOT DISTINCT FROM OLD."titleChangedAt" THEN
    NEW."previousTitle" := OLD."title";
    NEW."titleChangedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_title_changed_at BEFORE UPDATE ON "Contact"
  FOR EACH ROW EXECUTE FUNCTION contact_title_changed_at();
