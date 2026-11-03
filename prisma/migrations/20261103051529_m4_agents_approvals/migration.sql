-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'INVALID_OUTPUT', 'UNCITED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AgentActionTaken" AS ENUM ('NONE', 'DRAFTED', 'APPROVAL_REQUESTED', 'TASK_CREATED', 'NOTIFIED', 'EXECUTED', 'SENT');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('SEND_EMAIL', 'CREATE_TASK', 'UPDATE_FIELD', 'ENROLL_PLAY', 'BULK_ACTION', 'WRITE_BACK');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'EDITED_APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ApprovalLevel" AS ENUM ('NOTIFY_ONLY', 'DRAFT_FOR_APPROVAL', 'DRAFT_IN_MAILBOX', 'DO_AUTOMATICALLY', 'SEND_AUTOMATICALLY');

-- CreateEnum
CREATE TYPE "DecisionChannel" AS ENUM ('APP', 'SLACK');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'QUEUED', 'HELD', 'SENT', 'FAILED', 'BOUNCED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SendMode" AS ENUM ('APPROVED', 'AUTO');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL');

-- CreateEnum
CREATE TYPE "TodayItemType" AS ENUM ('TASK', 'SIGNAL', 'MEETING', 'APPROVAL', 'RENEWAL');

-- CreateEnum
CREATE TYPE "ExtractionSourceType" AS ENUM ('MESSAGE', 'TICKET', 'CALL_TRANSCRIPT', 'NOTE', 'SURVEY_RESPONSE', 'FILE');

-- CreateEnum
CREATE TYPE "ExtractionKind" AS ENUM ('SENTIMENT', 'COMPETITOR', 'BUDGET_CONCERN', 'PROMISE', 'GOAL', 'CANCEL_LANGUAGE', 'EXPORT_LANGUAGE', 'COMPLAINT', 'RENEWAL_CONCERN', 'ACTION_ITEM', 'DECISION', 'THEME', 'INTENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TASK_OVERDUE';
ALTER TYPE "NotificationType" ADD VALUE 'APPROVAL_ASSIGNED';

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "codeVersion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "approvalPolicyOverrides" JSONB NOT NULL DEFAULT '{}',
    "modelTierOverride" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "promptVersion" TEXT,
    "model" TEXT,
    "modelTier" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inputRefs" JSONB NOT NULL DEFAULT '[]',
    "accountId" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "reasoningSummary" TEXT,
    "confidence" DOUBLE PRECISION,
    "citations" JSONB,
    "actionTaken" "AgentActionTaken" NOT NULL DEFAULT 'NONE',
    "effects" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "proposedByAgentRunId" TEXT,
    "proposedByMembershipId" TEXT,
    "signalId" TEXT,
    "reason" TEXT NOT NULL,
    "proof" JSONB NOT NULL DEFAULT '[]',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedVia" "DecisionChannel",
    "decisionNote" TEXT,
    "editDiff" JSONB,
    "requiredLevel" "ApprovalLevel" NOT NULL,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "sensitiveReasons" TEXT[],
    "assigneeId" TEXT,
    "sourceKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "outboundMessageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "editedById" TEXT,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'HUMAN',
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "approvalId" TEXT,
    "signalId" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'DRAFT',
    "heldReason" TEXT,
    "sendMode" "SendMode" NOT NULL DEFAULT 'APPROVED',
    "guardResults" JSONB NOT NULL DEFAULT '[]',
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "transport" TEXT,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'HUMAN',
    "agentRunId" TEXT,
    "sourceKey" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodayItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "itemType" "TodayItemType" NOT NULL,
    "refId" TEXT NOT NULL,
    "accountId" TEXT,
    "title" TEXT NOT NULL,
    "rankScore" DOUBLE PRECISION NOT NULL,
    "rankReasons" JSONB NOT NULL,
    "dueAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TodayItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extraction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" "ExtractionSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "ExtractionKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "quote" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "itemIndex" INTEGER NOT NULL,
    "flags" TEXT[],
    "origin" "RecordOrigin" NOT NULL DEFAULT 'AI',
    "agentRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Extraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_workspaceId_id_key" ON "AgentDefinition"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_workspaceId_agentKey_key" ON "AgentDefinition"("workspaceId", "agentKey");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_agentKey_createdAt_idx" ON "AgentRun"("workspaceId", "agentKey", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_status_idx" ON "AgentRun"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_accountId_agentKey_createdAt_idx" ON "AgentRun"("workspaceId", "accountId", "agentKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_workspaceId_id_key" ON "AgentRun"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_workspaceId_idempotencyKey_key" ON "AgentRun"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_status_assigneeId_idx" ON "Approval"("workspaceId", "status", "assigneeId");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_accountId_idx" ON "Approval"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_workspaceId_id_key" ON "Approval"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_workspaceId_sourceKey_key" ON "Approval"("workspaceId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "DraftRevision_workspaceId_id_key" ON "DraftRevision"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DraftRevision_workspaceId_approvalId_version_key" ON "DraftRevision"("workspaceId", "approvalId", "version");

-- CreateIndex
CREATE INDEX "OutboundMessage_workspaceId_contactId_sentAt_idx" ON "OutboundMessage"("workspaceId", "contactId", "sentAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_workspaceId_accountId_sentAt_idx" ON "OutboundMessage"("workspaceId", "accountId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_workspaceId_id_key" ON "OutboundMessage"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_workspaceId_sourceKey_key" ON "OutboundMessage"("workspaceId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_workspaceId_approvalId_key" ON "OutboundMessage"("workspaceId", "approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_workspaceId_id_key" ON "EmailSuppression"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_workspaceId_email_key" ON "EmailSuppression"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "TodayItem_workspaceId_membershipId_itemType_rankScore_idx" ON "TodayItem"("workspaceId", "membershipId", "itemType", "rankScore");

-- CreateIndex
CREATE UNIQUE INDEX "TodayItem_workspaceId_id_key" ON "TodayItem"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TodayItem_workspaceId_membershipId_itemType_refId_key" ON "TodayItem"("workspaceId", "membershipId", "itemType", "refId");

-- CreateIndex
CREATE INDEX "Extraction_workspaceId_accountId_kind_createdAt_idx" ON "Extraction"("workspaceId", "accountId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Extraction_workspaceId_sourceType_sourceId_idx" ON "Extraction"("workspaceId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Extraction_workspaceId_id_key" ON "Extraction"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Extraction_workspaceId_sourceType_sourceId_promptVersion_it_key" ON "Extraction"("workspaceId", "sourceType", "sourceId", "promptVersion", "itemIndex");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StakeholderRole" ADD CONSTRAINT "StakeholderRole_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_sentimentAgentRunId_fkey" FOREIGN KEY ("workspaceId", "sentimentAgentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeRecord" ADD CONSTRAINT "OutcomeRecord_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_proposedByAgentRunId_fkey" FOREIGN KEY ("workspaceId", "proposedByAgentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_proposedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "proposedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_decidedById_fkey" FOREIGN KEY ("workspaceId", "decidedById") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_assigneeId_fkey" FOREIGN KEY ("workspaceId", "assigneeId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_signalId_fkey" FOREIGN KEY ("workspaceId", "signalId") REFERENCES "Signal"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_workspaceId_approvalId_fkey" FOREIGN KEY ("workspaceId", "approvalId") REFERENCES "Approval"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_workspaceId_outboundMessageId_fkey" FOREIGN KEY ("workspaceId", "outboundMessageId") REFERENCES "OutboundMessage"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_workspaceId_editedById_fkey" FOREIGN KEY ("workspaceId", "editedById") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_approvalId_fkey" FOREIGN KEY ("workspaceId", "approvalId") REFERENCES "Approval"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_signalId_fkey" FOREIGN KEY ("workspaceId", "signalId") REFERENCES "Signal"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodayItem" ADD CONSTRAINT "TodayItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodayItem" ADD CONSTRAINT "TodayItem_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodayItem" ADD CONSTRAINT "TodayItem_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extraction" ADD CONSTRAINT "Extraction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extraction" ADD CONSTRAINT "Extraction_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extraction" ADD CONSTRAINT "Extraction_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "AgentDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentDefinition" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentDefinition"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AgentRun"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Approval"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "DraftRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DraftRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DraftRevision"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "DraftRevision" ADD CONSTRAINT draftrevision_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

ALTER TABLE "OutboundMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OutboundMessage"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "OutboundMessage" ADD CONSTRAINT outboundmessage_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

ALTER TABLE "EmailSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSuppression" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmailSuppression"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "TodayItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TodayItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TodayItem"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Extraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Extraction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Extraction"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "Extraction" ADD CONSTRAINT extraction_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

-- ─── Rule 5: a SUCCEEDED run carries its full audit record (M4 §2) ───
ALTER TABLE "AgentRun" ADD CONSTRAINT agentrun_succeeded_complete CHECK (
  "status" <> 'SUCCEEDED' OR (
    "output" IS NOT NULL AND "reasoningSummary" IS NOT NULL AND "confidence" IS NOT NULL
    AND "promptVersion" IS NOT NULL AND "model" IS NOT NULL
  )
);
ALTER TABLE "AgentRun" ADD CONSTRAINT agentrun_confidence_range
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "AgentRun" ADD CONSTRAINT agentrun_failure_has_reason
  CHECK ("status" NOT IN ('INVALID_OUTPUT', 'UNCITED', 'FAILED', 'SKIPPED') OR "errorCode" IS NOT NULL);

-- ─── Approvals (Rules 1, 3; Q-31) ───
-- An agent's proposal carries proof.
ALTER TABLE "Approval" ADD CONSTRAINT approval_agent_proof
  CHECK ("proposedByAgentRunId" IS NULL OR jsonb_array_length("proof") >= 1);
-- Sensitive items are capped at DRAFT_FOR_APPROVAL; no setting can lift the cap.
ALTER TABLE "Approval" ADD CONSTRAINT approval_sensitive_cap
  CHECK (NOT "isSensitive" OR "requiredLevel" IN ('NOTIFY_ONLY', 'DRAFT_FOR_APPROVAL'));
-- Sensitive items are never decided from Slack.
ALTER TABLE "Approval" ADD CONSTRAINT approval_sensitive_not_slack
  CHECK (NOT "isSensitive" OR "decidedVia" IS DISTINCT FROM 'SLACK');
-- A decision names who made it and when.
ALTER TABLE "Approval" ADD CONSTRAINT approval_decision_recorded
  CHECK ("status" NOT IN ('APPROVED', 'EDITED_APPROVED', 'REJECTED')
         OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedVia" IS NOT NULL));
ALTER TABLE "Approval" ADD CONSTRAINT approval_edit_has_diff
  CHECK ("status" <> 'EDITED_APPROVED' OR "editDiff" IS NOT NULL);

-- ─── Outbound ───
ALTER TABLE "OutboundMessage" ADD CONSTRAINT outbound_sent_recorded
  CHECK ("status" <> 'SENT' OR ("sentAt" IS NOT NULL AND "providerMessageId" IS NOT NULL));
ALTER TABLE "OutboundMessage" ADD CONSTRAINT outbound_held_reason
  CHECK ("status" <> 'HELD' OR "heldReason" IS NOT NULL);
ALTER TABLE "EmailSuppression" ADD CONSTRAINT emailsuppression_lowercase
  CHECK ("email" = lower("email"));

-- ─── Draft versions are immutable: an edit writes a new version ───
CREATE FUNCTION draft_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DraftRevision rows are immutable: write a new version' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER draft_revision_immutable BEFORE UPDATE ON "DraftRevision"
  FOR EACH ROW EXECUTE FUNCTION draft_revision_immutable();

-- ─── Extractions keep a non-empty verbatim quote and a valid confidence ───
ALTER TABLE "Extraction" ADD CONSTRAINT extraction_quote_present CHECK (length("quote") > 0);
ALTER TABLE "Extraction" ADD CONSTRAINT extraction_confidence_range
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
