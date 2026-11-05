-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'ASK_ATTACHMENT';

-- CreateEnum
CREATE TYPE "ReportTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "AskRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "ReportSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "filtersHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "trigger" "ReportTrigger" NOT NULL,
    "generatedByMembershipId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "digestAgentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AskThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AskThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AskMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "AskRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportSnapshot_workspaceId_id_key" ON "ReportSnapshot"("workspaceId", "id");
CREATE INDEX "ReportSnapshot_workspaceId_reportKey_periodEnd_idx" ON "ReportSnapshot"("workspaceId", "reportKey", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AskThread_workspaceId_id_key" ON "AskThread"("workspaceId", "id");
CREATE INDEX "AskThread_workspaceId_userId_createdAt_idx" ON "AskThread"("workspaceId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AskMessage_workspaceId_id_key" ON "AskMessage"("workspaceId", "id");
CREATE INDEX "AskMessage_workspaceId_threadId_createdAt_idx" ON "AskMessage"("workspaceId", "threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_workspaceId_generatedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "generatedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_workspaceId_digestAgentRunId_fkey" FOREIGN KEY ("workspaceId", "digestAgentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AskThread" ADD CONSTRAINT "AskThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AskThread" ADD CONSTRAINT "AskThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AskThread" ADD CONSTRAINT "AskThread_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AskMessage" ADD CONSTRAINT "AskMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AskMessage" ADD CONSTRAINT "AskMessage_workspaceId_threadId_fkey" FOREIGN KEY ("workspaceId", "threadId") REFERENCES "AskThread"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AskMessage" ADD CONSTRAINT "AskMessage_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row Level Security (ARCHITECTURE §3.2, D-03)
ALTER TABLE "ReportSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ReportSnapshot"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "AskThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AskThread" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AskThread"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "AskMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AskMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AskMessage"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- Rule 5: an assistant message always names the AgentRun that produced it (no orphan AI text).
ALTER TABLE "AskMessage" ADD CONSTRAINT ask_message_agent_run_required
  CHECK ("role" <> 'ASSISTANT' OR "agentRunId" IS NOT NULL);

-- A report is a dated artefact: its content never changes (D-160). Only the digest run may be
-- attached once, NULL -> value.
CREATE FUNCTION report_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reportKey" IS DISTINCT FROM OLD."reportKey"
     OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
     OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
     OR NEW."filters" IS DISTINCT FROM OLD."filters"
     OR NEW."filtersHash" IS DISTINCT FROM OLD."filtersHash"
     OR NEW."data" IS DISTINCT FROM OLD."data"
     OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt" THEN
    RAISE EXCEPTION 'ReportSnapshot content is immutable: generate a new snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."digestAgentRunId" IS NOT NULL
     AND NEW."digestAgentRunId" IS DISTINCT FROM OLD."digestAgentRunId" THEN
    RAISE EXCEPTION 'ReportSnapshot.digestAgentRunId can be set only once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE ON "ReportSnapshot"
  FOR EACH ROW EXECUTE FUNCTION report_snapshot_immutable();

-- The M11 checkpoints are frozen comparisons: d30Outcome, d90Outcome and isTrueAlarm can change
-- only from NULL to a value.
CREATE FUNCTION outcome_checkpoint_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."d30Outcome" IS NOT NULL AND NEW."d30Outcome" IS DISTINCT FROM OLD."d30Outcome")
     OR (OLD."d90Outcome" IS NOT NULL AND NEW."d90Outcome" IS DISTINCT FROM OLD."d90Outcome")
     OR (OLD."isTrueAlarm" IS NOT NULL AND NEW."isTrueAlarm" IS DISTINCT FROM OLD."isTrueAlarm") THEN
    RAISE EXCEPTION 'OutcomeRecord checkpoints (d30Outcome, d90Outcome, isTrueAlarm) are frozen once written' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outcome_checkpoint_frozen BEFORE UPDATE ON "OutcomeRecord"
  FOR EACH ROW EXECUTE FUNCTION outcome_checkpoint_frozen();
