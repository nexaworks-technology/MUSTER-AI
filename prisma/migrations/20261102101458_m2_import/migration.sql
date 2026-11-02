-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('ACCOUNTS', 'CONTACTS', 'CONTRACTS', 'INVOICES', 'USAGE_ACCOUNT_DAILY', 'USAGE_USER_DAILY', 'USAGE_FEATURE_DAILY', 'TICKETS', 'TICKET_MESSAGES');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ExternalRef" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" "RecordSource" NOT NULL,
    "objectType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalType" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "integrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "fileObjectId" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "headers" TEXT[],
    "mapping" JSONB NOT NULL,
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsValid" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "errorPlain" TEXT,
    "createdByMembershipId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalRef_workspaceId_internalType_internalId_idx" ON "ExternalRef"("workspaceId", "internalType", "internalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_workspaceId_id_key" ON "ExternalRef"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_workspaceId_source_objectType_externalId_key" ON "ExternalRef"("workspaceId", "source", "objectType", "externalId");

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_createdAt_idx" ON "ImportJob"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJob_workspaceId_id_key" ON "ImportJob"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fileObjectId_fkey" FOREIGN KEY ("workspaceId", "fileObjectId") REFERENCES "FileObject"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "ExternalRef" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalRef" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ExternalRef"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "ImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportJob"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
