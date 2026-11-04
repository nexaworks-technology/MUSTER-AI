-- CreateEnum
CREATE TYPE "RenewalStage" AS ENUM ('UPCOMING', 'IN_PROGRESS', 'RENEWED', 'CHURNED');

-- CreateEnum
CREATE TYPE "ConfidenceBand" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ForecastCategory" AS ENUM ('COMMIT', 'BEST_CASE', 'AT_RISK', 'OMITTED');

-- CreateEnum
CREATE TYPE "RenewalResult" AS ENUM ('RENEWED', 'CHURNED');

-- CreateEnum
CREATE TYPE "OutcomeDetectedVia" AS ENUM ('CONTRACT_RECORDS', 'HUMAN');

-- CreateEnum
CREATE TYPE "ExpansionStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WON', 'LOST', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ExpansionMethod" AS ENUM ('SEATS_OVER_LIMIT', 'TIER_UPGRADE_DELTA');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('RENEWAL_BRIEF', 'QBR', 'SUCCESS_PLAN');

-- CreateTable
CREATE TABLE "Renewal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "renewalDate" DATE NOT NULL,
    "noticeDeadline" DATE,
    "arrAtRiskMinor" BIGINT,
    "currency" CHAR(3),
    "confidence" INTEGER NOT NULL,
    "confidenceBand" "ConfidenceBand" NOT NULL,
    "confidenceReasons" JSONB NOT NULL DEFAULT '[]',
    "confidenceAsOf" DATE NOT NULL,
    "stage" "RenewalStage" NOT NULL DEFAULT 'UPCOMING',
    "forecastCategory" "ForecastCategory",
    "forecastNote" TEXT,
    "forecastSetByMembershipId" TEXT,
    "forecastSetAt" TIMESTAMP(3),
    "planSteps" JSONB NOT NULL DEFAULT '[]',
    "briefDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Renewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenewalOutcome" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "renewalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "result" "RenewalResult" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "outcomeArrMinor" BIGINT,
    "currency" CHAR(3),
    "detectedVia" "OutcomeDetectedVia" NOT NULL,
    "recordedByMembershipId" TEXT,
    "note" TEXT,
    "forecastConfidence" INTEGER NOT NULL,
    "forecastBand" "ConfidenceBand" NOT NULL,
    "forecastCategory" "ForecastCategory",
    "forecastAsOf" DATE NOT NULL,
    "forecastArrAtRiskMinor" BIGINT,
    "forecastReasons" JSONB NOT NULL DEFAULT '[]',
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenewalOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpansionOpportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "signalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estimateMinor" BIGINT,
    "currency" CHAR(3),
    "estimateMethod" "ExpansionMethod",
    "isEstimate" BOOLEAN NOT NULL DEFAULT true,
    "ownerMembershipId" TEXT,
    "nextStep" TEXT,
    "nextStepDate" DATE,
    "status" "ExpansionStatus" NOT NULL DEFAULT 'OPEN',
    "crmExternalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpansionOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "narrative" JSONB NOT NULL DEFAULT '[]',
    "origin" "RecordOrigin" NOT NULL DEFAULT 'SYSTEM',
    "agentRunId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Renewal_workspaceId_renewalDate_idx" ON "Renewal"("workspaceId", "renewalDate");

-- CreateIndex
CREATE INDEX "Renewal_workspaceId_accountId_idx" ON "Renewal"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_workspaceId_id_key" ON "Renewal"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_workspaceId_contractId_renewalDate_key" ON "Renewal"("workspaceId", "contractId", "renewalDate");

-- CreateIndex
CREATE INDEX "RenewalOutcome_workspaceId_renewalId_idx" ON "RenewalOutcome"("workspaceId", "renewalId");

-- CreateIndex
CREATE INDEX "RenewalOutcome_workspaceId_accountId_occurredOn_idx" ON "RenewalOutcome"("workspaceId", "accountId", "occurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "RenewalOutcome_workspaceId_id_key" ON "RenewalOutcome"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ExpansionOpportunity_workspaceId_accountId_status_idx" ON "ExpansionOpportunity"("workspaceId", "accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExpansionOpportunity_workspaceId_id_key" ON "ExpansionOpportunity"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Document_workspaceId_accountId_kind_idx" ON "Document"("workspaceId", "accountId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Document_workspaceId_id_key" ON "Document"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_workspaceId_contractId_fkey" FOREIGN KEY ("workspaceId", "contractId") REFERENCES "Contract"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_workspaceId_forecastSetByMembershipId_fkey" FOREIGN KEY ("workspaceId", "forecastSetByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_workspaceId_briefDocumentId_fkey" FOREIGN KEY ("workspaceId", "briefDocumentId") REFERENCES "Document"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT "RenewalOutcome_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT "RenewalOutcome_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT "RenewalOutcome_workspaceId_renewalId_fkey" FOREIGN KEY ("workspaceId", "renewalId") REFERENCES "Renewal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT "RenewalOutcome_workspaceId_recordedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "recordedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT "RenewalOutcome_workspaceId_supersedesId_fkey" FOREIGN KEY ("workspaceId", "supersedesId") REFERENCES "RenewalOutcome"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionOpportunity" ADD CONSTRAINT "ExpansionOpportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionOpportunity" ADD CONSTRAINT "ExpansionOpportunity_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionOpportunity" ADD CONSTRAINT "ExpansionOpportunity_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_agentRunId_fkey" FOREIGN KEY ("workspaceId", "agentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ─── Tenant isolation (Rule 2) ───────────────────────────────────────────────────────────
ALTER TABLE "Renewal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Renewal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Renewal"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "RenewalOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RenewalOutcome" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RenewalOutcome"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "ExpansionOpportunity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExpansionOpportunity" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ExpansionOpportunity"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Document"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- ─── Renewal: bounded likelihood; a category is a person's call (D3) ─────────────────────
ALTER TABLE "Renewal" ADD CONSTRAINT renewal_confidence_range
  CHECK ("confidence" BETWEEN 0 AND 100);
ALTER TABLE "Renewal" ADD CONSTRAINT renewal_category_has_author
  CHECK ("forecastCategory" IS NULL
         OR ("forecastSetByMembershipId" IS NOT NULL AND "forecastSetAt" IS NOT NULL));

-- ─── RenewalOutcome: append-only, with the frozen forecast (M7 rule 7) ───────────────────
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT outcome_forecast_range
  CHECK ("forecastConfidence" BETWEEN 0 AND 100);
ALTER TABLE "RenewalOutcome" ADD CONSTRAINT outcome_human_has_author
  CHECK ("detectedVia" <> 'HUMAN' OR "recordedByMembershipId" IS NOT NULL);
-- One original outcome per renewal; corrections are further rows that name what they replace.
CREATE UNIQUE INDEX "RenewalOutcome_one_original" ON "RenewalOutcome" ("workspaceId", "renewalId")
  WHERE "supersedesId" IS NULL;
CREATE FUNCTION renewal_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RenewalOutcome rows are immutable: write a correction row' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER renewal_outcome_immutable BEFORE UPDATE ON "RenewalOutcome"
  FOR EACH ROW EXECUTE FUNCTION renewal_outcome_immutable();

-- ─── ExpansionOpportunity: an estimate is always an estimate and always has a method ─────
ALTER TABLE "ExpansionOpportunity" ADD CONSTRAINT expansion_is_estimate
  CHECK ("isEstimate");
ALTER TABLE "ExpansionOpportunity" ADD CONSTRAINT expansion_estimate_has_method
  CHECK ("estimateMinor" IS NULL OR ("estimateMethod" IS NOT NULL AND "currency" IS NOT NULL));

-- ─── Document: an AI-written document names the run that wrote it (Rule 5) ───────────────
ALTER TABLE "Document" ADD CONSTRAINT document_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);
