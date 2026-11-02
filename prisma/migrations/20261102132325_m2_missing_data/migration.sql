-- CreateEnum
CREATE TYPE "MissingDataField" AS ENUM ('OWNER', 'RENEWAL_DATE', 'KEY_CONTACT');

-- CreateTable
CREATE TABLE "MissingDataPrompt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "field" "MissingDataField" NOT NULL,
    "askedMembershipId" TEXT,
    "askedAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "answeredByMembershipId" TEXT,
    "skippedAt" TIMESTAMP(3),
    "snoozeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissingDataPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MissingDataPrompt_workspaceId_askedMembershipId_askedAt_idx" ON "MissingDataPrompt"("workspaceId", "askedMembershipId", "askedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MissingDataPrompt_workspaceId_id_key" ON "MissingDataPrompt"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissingDataPrompt_workspaceId_accountId_field_key" ON "MissingDataPrompt"("workspaceId", "accountId", "field");

-- AddForeignKey
ALTER TABLE "MissingDataPrompt" ADD CONSTRAINT "MissingDataPrompt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingDataPrompt" ADD CONSTRAINT "MissingDataPrompt_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissingDataPrompt" ADD CONSTRAINT "MissingDataPrompt_workspaceId_askedMembershipId_fkey" FOREIGN KEY ("workspaceId", "askedMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "MissingDataPrompt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MissingDataPrompt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MissingDataPrompt"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
