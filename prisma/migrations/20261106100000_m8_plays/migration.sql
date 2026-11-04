-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'AUTO_RECORDED';

-- CreateEnum
CREATE TYPE "PlayStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'KILLED');

-- CreateEnum
CREATE TYPE "PlayRunStatus" AS ENUM ('RUNNING', 'WAITING', 'COMPLETED', 'EXITED', 'FAILED');

-- CreateEnum
CREATE TYPE "PlayStepRunStatus" AS ENUM ('PENDING', 'WAITING_APPROVAL', 'DONE', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "Play" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "status" "PlayStatus" NOT NULL DEFAULT 'DRAFT',
    "isSeeded" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Play_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "playId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "safetyCheck" JSONB,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "playId" TEXT NOT NULL,
    "playVersionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "triggerRef" TEXT NOT NULL,
    "signalId" TEXT,
    "status" "PlayRunStatus" NOT NULL DEFAULT 'RUNNING',
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayStepRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "playRunId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "status" "PlayStepRunStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3),
    "approvalId" TEXT,
    "taskId" TEXT,
    "outboundMessageId" TEXT,
    "agentRunId" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayStepRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Play_workspaceId_id_key" ON "Play"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Play_workspaceId_key_key" ON "Play"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "Play_workspaceId_status_idx" ON "Play"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlayVersion_workspaceId_id_key" ON "PlayVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlayVersion_workspaceId_playId_version_key" ON "PlayVersion"("workspaceId", "playId", "version");

-- CreateIndex
CREATE INDEX "PlayVersion_workspaceId_playId_idx" ON "PlayVersion"("workspaceId", "playId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayRun_workspaceId_id_key" ON "PlayRun"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlayRun_workspaceId_playId_accountId_triggerRef_key" ON "PlayRun"("workspaceId", "playId", "accountId", "triggerRef");

-- CreateIndex
CREATE INDEX "PlayRun_workspaceId_playId_accountId_status_idx" ON "PlayRun"("workspaceId", "playId", "accountId", "status");

-- CreateIndex
CREATE INDEX "PlayRun_workspaceId_status_idx" ON "PlayRun"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlayStepRun_workspaceId_id_key" ON "PlayStepRun"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlayStepRun_workspaceId_playRunId_stepKey_key" ON "PlayStepRun"("workspaceId", "playRunId", "stepKey");

-- CreateIndex
CREATE INDEX "PlayStepRun_workspaceId_status_scheduledFor_idx" ON "PlayStepRun"("workspaceId", "status", "scheduledFor");

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_workspaceId_currentVersionId_fkey" FOREIGN KEY ("workspaceId", "currentVersionId") REFERENCES "PlayVersion"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayVersion" ADD CONSTRAINT "PlayVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayVersion" ADD CONSTRAINT "PlayVersion_workspaceId_playId_fkey" FOREIGN KEY ("workspaceId", "playId") REFERENCES "Play"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayVersion" ADD CONSTRAINT "PlayVersion_workspaceId_publishedById_fkey" FOREIGN KEY ("workspaceId", "publishedById") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayRun" ADD CONSTRAINT "PlayRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayRun" ADD CONSTRAINT "PlayRun_workspaceId_playId_fkey" FOREIGN KEY ("workspaceId", "playId") REFERENCES "Play"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayRun" ADD CONSTRAINT "PlayRun_workspaceId_playVersionId_fkey" FOREIGN KEY ("workspaceId", "playVersionId") REFERENCES "PlayVersion"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayRun" ADD CONSTRAINT "PlayRun_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayRun" ADD CONSTRAINT "PlayRun_workspaceId_signalId_fkey" FOREIGN KEY ("workspaceId", "signalId") REFERENCES "Signal"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_playRunId_fkey" FOREIGN KEY ("workspaceId", "playRunId") REFERENCES "PlayRun"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_approvalId_fkey" FOREIGN KEY ("workspaceId", "approvalId") REFERENCES "Approval"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_taskId_fkey" FOREIGN KEY ("workspaceId", "taskId") REFERENCES "Task"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_outboundMessageId_fkey" FOREIGN KEY ("workspaceId", "outboundMessageId") REFERENCES "OutboundMessage"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayStepRun" ADD CONSTRAINT "PlayStepRun_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row Level Security
ALTER TABLE "Play" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Play" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Play"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "PlayVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PlayVersion"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "PlayRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PlayRun"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "PlayStepRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlayStepRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PlayStepRun"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- ─── D3 backlog data migration: mark pre-M8 unprocessed outbox events as processed ───
UPDATE "OutboxEvent" SET "processedAt" = NOW() WHERE "processedAt" IS NULL;
