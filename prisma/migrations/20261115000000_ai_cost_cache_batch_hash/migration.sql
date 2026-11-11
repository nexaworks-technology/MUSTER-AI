-- AI cost session (docs/AI-COST-2026-11-11.md): what each run read from and wrote to the prompt
-- cache, a hash of the exact inputs (so an unchanged account makes no model call), and the Message
-- Batches id for runs submitted as a batch (the batch custom_id is the run id).
ALTER TABLE "AgentRun" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRun" ADD COLUMN "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRun" ADD COLUMN "inputHash" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "batchId" TEXT;

CREATE INDEX "AgentRun_workspaceId_batchId_idx" ON "AgentRun"("workspaceId", "batchId");
