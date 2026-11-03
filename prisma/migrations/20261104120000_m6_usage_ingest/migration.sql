-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "ingestKeyHash" TEXT,
ADD COLUMN     "ingestKeyLast4" TEXT,
ADD COLUMN     "ingestKeyRotatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UsageIngestBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "events" INTEGER NOT NULL,
    "unmatched" JSONB NOT NULL DEFAULT '[]',
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageIngestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageIngestBatch_workspaceId_integrationId_appliedAt_idx" ON "UsageIngestBatch"("workspaceId", "integrationId", "appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageIngestBatch_workspaceId_id_key" ON "UsageIngestBatch"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageIngestBatch_workspaceId_integrationId_batchKey_key" ON "UsageIngestBatch"("workspaceId", "integrationId", "batchKey");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_ingestKeyHash_key" ON "Integration"("ingestKeyHash");

-- AddForeignKey
ALTER TABLE "UsageIngestBatch" ADD CONSTRAINT "UsageIngestBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageIngestBatch" ADD CONSTRAINT "UsageIngestBatch_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Tenant isolation (Rule 2) ───────────────────────────────────────────────────────────
ALTER TABLE "UsageIngestBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageIngestBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UsageIngestBatch"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- ─── Ingest key ──────────────────────────────────────────────────────────────────────────
-- A usage request names no workspace, only its key. This read-only policy admits exactly the one
-- row whose stored hash equals the transaction-local hash (the webhook-id pattern, D-90).
CREATE POLICY integration_usage_key_read ON "Integration" FOR SELECT
  USING ("provider" = 'USAGE_API' AND "ingestKeyHash" IS NOT NULL
         AND "ingestKeyHash" = current_setting('app.usage_key_hash', true));

-- Only the Usage API has a key, hash and last four travel together, and a disconnected
-- integration keeps no key.
ALTER TABLE "Integration" ADD CONSTRAINT "integration_ingest_key_shape" CHECK (
  ("ingestKeyHash" IS NULL AND "ingestKeyLast4" IS NULL)
  OR ("provider" = 'USAGE_API' AND "ingestKeyHash" IS NOT NULL AND "ingestKeyLast4" IS NOT NULL
      AND "status" <> 'DISCONNECTED')
);
