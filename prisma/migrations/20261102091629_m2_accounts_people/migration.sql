-- CreateEnum
CREATE TYPE "AccountTier" AS ENUM ('HIGH_TOUCH', 'MID_TOUCH', 'LONG_TAIL');

-- CreateEnum
CREATE TYPE "TierSource" AS ENUM ('RULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "LifecycleStage" AS ENUM ('ONBOARDING', 'ADOPTING', 'MATURE', 'RENEWING', 'LOST');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('CSV', 'MANUAL', 'SEED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RecordOrigin" AS ENUM ('HUMAN', 'SYSTEM', 'AI', 'IMPORT');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'BOUNCED', 'LEFT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "StakeholderRoleType" AS ENUM ('CHAMPION', 'DECISION_MAKER', 'DAILY_USER', 'EXEC_SPONSOR', 'BILLING', 'OTHER');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "tier" "AccountTier" NOT NULL,
    "tierSource" "TierSource" NOT NULL DEFAULT 'RULE',
    "lifecycleStage" "LifecycleStage" NOT NULL DEFAULT 'ADOPTING',
    "stageChangedAt" TIMESTAMP(3),
    "onboardingStartedAt" TIMESTAMP(3),
    "churnedAt" TIMESTAMP(3),
    "ownerMembershipId" TEXT,
    "plan" TEXT,
    "industry" TEXT,
    "employeeBand" TEXT,
    "useCase" TEXT,
    "timezone" TEXT,
    "arrMinor" BIGINT,
    "arrCurrency" CHAR(3),
    "lastTouchAt" TIMESTAMP(3),
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "title" TEXT,
    "timezone" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "externalUserId" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StakeholderRole" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" "StakeholderRoleType" NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "setByMembershipId" TEXT,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'HUMAN',
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StakeholderRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Account_workspaceId_ownerMembershipId_idx" ON "Account"("workspaceId", "ownerMembershipId");

-- CreateIndex
CREATE INDEX "Account_workspaceId_tier_idx" ON "Account"("workspaceId", "tier");

-- CreateIndex
CREATE INDEX "Account_workspaceId_lifecycleStage_idx" ON "Account"("workspaceId", "lifecycleStage");

-- CreateIndex
CREATE INDEX "Account_workspaceId_name_idx" ON "Account"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Account_workspaceId_domain_idx" ON "Account"("workspaceId", "domain");

-- CreateIndex
CREATE INDEX "Account_workspaceId_arrMinor_idx" ON "Account"("workspaceId", "arrMinor");

-- CreateIndex
CREATE INDEX "Account_workspaceId_lastTouchAt_idx" ON "Account"("workspaceId", "lastTouchAt");

-- CreateIndex
CREATE UNIQUE INDEX "Account_workspaceId_id_key" ON "Account"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_accountId_idx" ON "Contact"("workspaceId", "accountId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_workspaceId_id_key" ON "Contact"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "StakeholderRole_workspaceId_accountId_role_validTo_idx" ON "StakeholderRole"("workspaceId", "accountId", "role", "validTo");

-- CreateIndex
CREATE INDEX "StakeholderRole_workspaceId_contactId_idx" ON "StakeholderRole"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "StakeholderRole_workspaceId_id_key" ON "StakeholderRole"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StakeholderRole" ADD CONSTRAINT "StakeholderRole_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StakeholderRole" ADD CONSTRAINT "StakeholderRole_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StakeholderRole" ADD CONSTRAINT "StakeholderRole_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Account"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Contact"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "StakeholderRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StakeholderRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StakeholderRole"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "StakeholderRole" ADD CONSTRAINT stakeholderrole_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);
