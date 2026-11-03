-- CreateEnum
CREATE TYPE "OnboardingPlanStatus" AS ENUM ('ACTIVE', 'STALLED', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StepOwnerSide" AS ENUM ('US', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "StepCompletion" AS ENUM ('HUMAN', 'PRODUCT_EVENT');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('OPEN', 'ACHIEVED', 'MISSED', 'DROPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'USAGE_API';
ALTER TYPE "IntegrationProvider" ADD VALUE 'MIXPANEL';
ALTER TYPE "IntegrationProvider" ADD VALUE 'AMPLITUDE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordSource" ADD VALUE 'USAGE_API';
ALTER TYPE "RecordSource" ADD VALUE 'MIXPANEL';
ALTER TYPE "RecordSource" ADD VALUE 'AMPLITUDE';

-- CreateTable
CREATE TABLE "OnboardingTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "forTier" "AccountTier",
    "forPlan" TEXT,
    "targetDays" INTEGER NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "valueDefinition" JSONB NOT NULL DEFAULT '[]',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "templateId" TEXT,
    "startDate" DATE NOT NULL,
    "targetValueDate" DATE NOT NULL,
    "valueReachedAt" DATE,
    "valueEvidence" JSONB NOT NULL DEFAULT '[]',
    "status" "OnboardingPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "stallReason" TEXT,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "handoff" JSONB NOT NULL DEFAULT '{}',
    "lastEvaluatedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingStep" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "ownerSide" "StepOwnerSide" NOT NULL,
    "ownerMembershipId" TEXT,
    "ownerContactId" TEXT,
    "dueDate" DATE NOT NULL,
    "completesWhen" JSONB,
    "doneAt" TIMESTAMP(3),
    "completedVia" "StepCompletion",
    "completedByMembershipId" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "successPlanId" TEXT,
    "text" TEXT NOT NULL,
    "metricKey" TEXT,
    "targetValue" DOUBLE PRECISION,
    "status" "GoalStatus" NOT NULL DEFAULT 'OPEN',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "quote" TEXT,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'HUMAN',
    "agentRunId" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingTemplate_workspaceId_id_key" ON "OnboardingTemplate"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingTemplate_workspaceId_name_key" ON "OnboardingTemplate"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "OnboardingPlan_workspaceId_status_idx" ON "OnboardingPlan"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "OnboardingPlan_workspaceId_accountId_idx" ON "OnboardingPlan"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingPlan_workspaceId_id_key" ON "OnboardingPlan"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "OnboardingStep_workspaceId_planId_idx" ON "OnboardingStep"("workspaceId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingStep_workspaceId_id_key" ON "OnboardingStep"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingStep_workspaceId_planId_key_key" ON "OnboardingStep"("workspaceId", "planId", "key");

-- CreateIndex
CREATE INDEX "Goal_workspaceId_accountId_idx" ON "Goal"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Goal_workspaceId_id_key" ON "Goal"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "OnboardingTemplate" ADD CONSTRAINT "OnboardingTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingPlan" ADD CONSTRAINT "OnboardingPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingPlan" ADD CONSTRAINT "OnboardingPlan_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingPlan" ADD CONSTRAINT "OnboardingPlan_workspaceId_templateId_fkey" FOREIGN KEY ("workspaceId", "templateId") REFERENCES "OnboardingTemplate"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_workspaceId_planId_fkey" FOREIGN KEY ("workspaceId", "planId") REFERENCES "OnboardingPlan"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_workspaceId_ownerContactId_fkey" FOREIGN KEY ("workspaceId", "ownerContactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingStep" ADD CONSTRAINT "OnboardingStep_workspaceId_completedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "completedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Tenant isolation (Rule 2) ───────────────────────────────────────────────────────────
ALTER TABLE "OnboardingTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OnboardingTemplate"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "OnboardingPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OnboardingPlan"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "OnboardingStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OnboardingStep"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Goal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Goal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Goal"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- Rule 5: an AI-written goal names the agent run that wrote it.
ALTER TABLE "Goal" ADD CONSTRAINT goal_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

-- D1: a step is done by a person or by a verified product event with its proof; never "just done".
ALTER TABLE "OnboardingStep" ADD CONSTRAINT onboarding_step_done_has_how
  CHECK (("doneAt" IS NULL) = ("completedVia" IS NULL));
ALTER TABLE "OnboardingStep" ADD CONSTRAINT onboarding_step_human_has_member
  CHECK ("completedVia" IS DISTINCT FROM 'HUMAN' OR "completedByMembershipId" IS NOT NULL);
ALTER TABLE "OnboardingStep" ADD CONSTRAINT onboarding_step_event_has_evidence
  CHECK ("completedVia" IS DISTINCT FROM 'PRODUCT_EVENT' OR jsonb_array_length("evidence") > 0);
ALTER TABLE "OnboardingStep" ADD CONSTRAINT onboarding_step_one_owner
  CHECK (("ownerSide" = 'US' AND "ownerContactId" IS NULL) OR ("ownerSide" = 'CUSTOMER' AND "ownerMembershipId" IS NULL));

-- Value reached needs its proof too (D3).
ALTER TABLE "OnboardingPlan" ADD CONSTRAINT onboarding_plan_value_has_evidence
  CHECK ("valueReachedAt" IS NULL OR jsonb_array_length("valueEvidence") > 0);

-- At most one open plan per account (ARCHITECTURE §3.2).
CREATE UNIQUE INDEX onboarding_plan_one_open
  ON "OnboardingPlan" ("workspaceId", "accountId")
  WHERE "status" IN ('ACTIVE', 'STALLED');
