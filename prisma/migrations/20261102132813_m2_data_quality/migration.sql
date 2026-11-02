-- CreateEnum
CREATE TYPE "DataQualityKind" AS ENUM ('DUPLICATE_ACCOUNT', 'DUPLICATE_CONTACT', 'INVALID_EMAIL', 'STALE');

-- CreateEnum
CREATE TYPE "DataQualityStatus" AS ENUM ('OPEN', 'FIXED', 'DISMISSED', 'RESOLVED');

-- CreateTable
CREATE TABLE "DataQualityIssue" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "contactId" TEXT,
    "kind" "DataQualityKind" NOT NULL,
    "detail" TEXT NOT NULL,
    "suggestedFix" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "DataQualityStatus" NOT NULL DEFAULT 'OPEN',
    "fixedByMembershipId" TEXT,
    "fixedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataQualityIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataQualityIssue_workspaceId_status_idx" ON "DataQualityIssue"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataQualityIssue_workspaceId_id_key" ON "DataQualityIssue"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DataQualityIssue_workspaceId_dedupeKey_key" ON "DataQualityIssue"("workspaceId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "DataQualityIssue" ADD CONSTRAINT "DataQualityIssue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataQualityIssue" ADD CONSTRAINT "DataQualityIssue_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "DataQualityIssue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataQualityIssue" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DataQualityIssue"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
