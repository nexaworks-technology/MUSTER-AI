-- CreateEnum
CREATE TYPE "HealthModelStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "HealthModelOrigin" AS ENUM ('SYSTEM_DEFAULT', 'BACKTEST_PROPOSAL', 'HUMAN');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('HEALTHY', 'WATCH', 'AT_RISK', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "HealthPillar" AS ENUM ('ADOPTION', 'ENGAGEMENT', 'SUPPORT', 'RELATIONSHIP', 'COMMERCIAL', 'SENTIMENT');

-- CreateEnum
CREATE TYPE "ReasonDirection" AS ENUM ('UP', 'DOWN', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "ReasonKind" AS ENUM ('EVIDENCE', 'MISSING_DATA');

-- CreateEnum
CREATE TYPE "PulseValue" AS ENUM ('FINE', 'WORRIED');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "currentHealthSnapshotId" TEXT;

-- CreateTable
CREATE TABLE "HealthModel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "HealthModelStatus" NOT NULL DEFAULT 'DRAFT',
    "proposedBy" "HealthModelOrigin" NOT NULL,
    "pillarWeights" JSONB NOT NULL,
    "componentConfig" JSONB NOT NULL,
    "thresholds" JSONB NOT NULL,
    "perTierOverrides" JSONB NOT NULL DEFAULT '{}',
    "backtestResult" JSONB,
    "basedOnVersion" INTEGER,
    "note" TEXT,
    "createdByMembershipId" TEXT,
    "approvedByMembershipId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthScoreSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "healthModelId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "overall" DECIMAL(5,2),
    "adoption" DECIMAL(5,2),
    "engagement" DECIMAL(5,2),
    "support" DECIMAL(5,2),
    "relationship" DECIMAL(5,2),
    "commercial" DECIMAL(5,2),
    "sentiment" DECIMAL(5,2),
    "overallExcludingPulse" DECIMAL(5,2),
    "riskLevel" "RiskLevel" NOT NULL,
    "riskLevelExcludingPulse" "RiskLevel" NOT NULL,
    "riskReasonId" TEXT,
    "pulseValue" "PulseValue",
    "pulseId" TEXT,
    "pulseDisagreement" BOOLEAN NOT NULL DEFAULT false,
    "effectiveWeights" JSONB NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "isBacktest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthReason" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "pillar" "HealthPillar" NOT NULL,
    "component" TEXT NOT NULL,
    "kind" "ReasonKind" NOT NULL,
    "direction" "ReasonDirection" NOT NULL,
    "impact" DECIMAL(6,2) NOT NULL,
    "score" DECIMAL(5,2),
    "message" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "value" DECIMAL(14,4),
    "baseline" DECIMAL(14,4),
    "delta" DECIMAL(14,4),
    "cohortValue" DECIMAL(14,4),
    "cohortKey" TEXT,
    "cohortSize" INTEGER,
    "periodStart" DATE,
    "periodEnd" DATE,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CsmPulse" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "value" "PulseValue" NOT NULL,
    "comment" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CsmPulse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageBaseline" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "windowEnd" DATE NOT NULL,
    "accountMedian" DECIMAL(14,4),
    "accountP25" DECIMAL(14,4),
    "historyDays" INTEGER NOT NULL,
    "cohortKey" TEXT,
    "cohortMedian" DECIMAL(14,4),
    "cohortSize" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HealthModel_workspaceId_id_key" ON "HealthModel"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HealthModel_workspaceId_version_key" ON "HealthModel"("workspaceId", "version");

-- CreateIndex
CREATE INDEX "HealthScoreSnapshot_workspaceId_asOf_riskLevel_idx" ON "HealthScoreSnapshot"("workspaceId", "asOf", "riskLevel");

-- CreateIndex
CREATE UNIQUE INDEX "HealthScoreSnapshot_workspaceId_id_key" ON "HealthScoreSnapshot"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HealthScoreSnapshot_workspaceId_accountId_healthModelId_asO_key" ON "HealthScoreSnapshot"("workspaceId", "accountId", "healthModelId", "asOf", "isBacktest");

-- CreateIndex
CREATE INDEX "HealthReason_workspaceId_snapshotId_idx" ON "HealthReason"("workspaceId", "snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthReason_workspaceId_id_key" ON "HealthReason"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HealthReason_workspaceId_snapshotId_id_key" ON "HealthReason"("workspaceId", "snapshotId", "id");

-- CreateIndex
CREATE INDEX "CsmPulse_workspaceId_accountId_createdAt_idx" ON "CsmPulse"("workspaceId", "accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CsmPulse_workspaceId_id_key" ON "CsmPulse"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageBaseline_workspaceId_id_key" ON "UsageBaseline"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageBaseline_workspaceId_accountId_metric_windowEnd_key" ON "UsageBaseline"("workspaceId", "accountId", "metric", "windowEnd");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_workspaceId_currentHealthSnapshotId_fkey" FOREIGN KEY ("workspaceId", "currentHealthSnapshotId") REFERENCES "HealthScoreSnapshot"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthModel" ADD CONSTRAINT "HealthModel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthModel" ADD CONSTRAINT "HealthModel_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthModel" ADD CONSTRAINT "HealthModel_workspaceId_approvedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "approvedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT "HealthScoreSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT "HealthScoreSnapshot_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT "HealthScoreSnapshot_workspaceId_healthModelId_fkey" FOREIGN KEY ("workspaceId", "healthModelId") REFERENCES "HealthModel"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT "HealthScoreSnapshot_workspaceId_id_riskReasonId_fkey" FOREIGN KEY ("workspaceId", "id", "riskReasonId") REFERENCES "HealthReason"("workspaceId", "snapshotId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT "HealthScoreSnapshot_workspaceId_pulseId_fkey" FOREIGN KEY ("workspaceId", "pulseId") REFERENCES "CsmPulse"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReason" ADD CONSTRAINT "HealthReason_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReason" ADD CONSTRAINT "HealthReason_workspaceId_snapshotId_fkey" FOREIGN KEY ("workspaceId", "snapshotId") REFERENCES "HealthScoreSnapshot"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsmPulse" ADD CONSTRAINT "CsmPulse_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsmPulse" ADD CONSTRAINT "CsmPulse_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsmPulse" ADD CONSTRAINT "CsmPulse_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageBaseline" ADD CONSTRAINT "UsageBaseline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageBaseline" ADD CONSTRAINT "UsageBaseline_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "HealthModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthModel" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "HealthModel"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "HealthScoreSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthScoreSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "HealthScoreSnapshot"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "HealthReason" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthReason" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "HealthReason"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "CsmPulse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CsmPulse" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CsmPulse"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "UsageBaseline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageBaseline" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UsageBaseline"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- ─── Health: proof enforced by the database (M3 rule 2, ARCHITECTURE §3.2) ───

-- One ACTIVE model per workspace.
CREATE UNIQUE INDEX "HealthModel_one_active" ON "HealthModel" ("workspaceId") WHERE status = 'ACTIVE';

-- An evidence reason names at least one source record; a missing-data reason may not.
ALTER TABLE "HealthReason" ADD CONSTRAINT healthreason_evidence_has_sources
  CHECK (kind = 'MISSING_DATA' OR jsonb_array_length(sources) >= 1);

-- At Risk needs a named reason.
ALTER TABLE "HealthScoreSnapshot" ADD CONSTRAINT healthsnapshot_at_risk_has_reason
  CHECK ("riskLevel" <> 'AT_RISK' OR "riskReasonId" IS NOT NULL);

-- ...and that reason must be one of this snapshot's own (composite FK), checked at commit so
-- the snapshot and its reasons are written in one transaction.
ALTER TABLE "HealthScoreSnapshot" ALTER CONSTRAINT "HealthScoreSnapshot_workspaceId_id_riskReasonId_fkey"
  DEFERRABLE INITIALLY DEFERRED;

-- At commit: every pillar with a value has ≥ 1 EVIDENCE reason, and the risk reason is EVIDENCE.
CREATE FUNCTION health_snapshot_has_proof(sid text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s "HealthScoreSnapshot"%ROWTYPE;
  p text;
  v numeric;
BEGIN
  SELECT * INTO s FROM "HealthScoreSnapshot" WHERE id = sid;
  IF NOT FOUND THEN RETURN; END IF;
  FOREACH p IN ARRAY ARRAY['ADOPTION','ENGAGEMENT','SUPPORT','RELATIONSHIP','COMMERCIAL','SENTIMENT'] LOOP
    v := CASE p
      WHEN 'ADOPTION' THEN s.adoption WHEN 'ENGAGEMENT' THEN s.engagement
      WHEN 'SUPPORT' THEN s.support WHEN 'RELATIONSHIP' THEN s.relationship
      WHEN 'COMMERCIAL' THEN s.commercial ELSE s.sentiment END;
    IF v IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "HealthReason" r
      WHERE r."snapshotId" = sid AND r.pillar::text = p AND r.kind = 'EVIDENCE'
    ) THEN
      RAISE EXCEPTION 'Health snapshot % has a % score but no evidence reason', sid, p
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF s."riskReasonId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "HealthReason" r WHERE r.id = s."riskReasonId" AND r.kind = 'EVIDENCE'
  ) THEN
    RAISE EXCEPTION 'Health snapshot % names a risk reason that is not evidence', sid
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION health_snapshot_proof_on_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM health_snapshot_has_proof(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER health_snapshot_proof AFTER INSERT ON "HealthScoreSnapshot"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION health_snapshot_proof_on_snapshot();

-- Deleting a reason re-checks its snapshot (a cascade from the snapshot itself finds no row).
CREATE FUNCTION health_snapshot_proof_on_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM health_snapshot_has_proof(OLD."snapshotId");
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER health_reason_proof AFTER DELETE ON "HealthReason"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION health_snapshot_proof_on_reason();

-- Snapshots and reasons are history: never edited (a same-day re-score under the same model
-- version replaces the row; another version writes its own rows).
CREATE FUNCTION health_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER health_snapshot_immutable BEFORE UPDATE ON "HealthScoreSnapshot"
  FOR EACH ROW EXECUTE FUNCTION health_history_immutable();
CREATE TRIGGER health_reason_immutable BEFORE UPDATE ON "HealthReason"
  FOR EACH ROW EXECUTE FUNCTION health_history_immutable();

-- A model is frozen once it leaves DRAFT; only its status/approval/activation may move on.
CREATE FUNCTION health_model_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    NEW."pillarWeights" IS DISTINCT FROM OLD."pillarWeights"
    OR NEW."componentConfig" IS DISTINCT FROM OLD."componentConfig"
    OR NEW.thresholds IS DISTINCT FROM OLD.thresholds
    OR NEW."perTierOverrides" IS DISTINCT FROM OLD."perTierOverrides"
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW."backtestResult" IS DISTINCT FROM OLD."backtestResult"
  ) THEN
    RAISE EXCEPTION 'HealthModel version % is %: create a new version instead', OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED' THEN
    RAISE EXCEPTION 'A retired HealthModel cannot be reactivated' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER health_model_frozen BEFORE UPDATE ON "HealthModel"
  FOR EACH ROW EXECUTE FUNCTION health_model_frozen();

-- Pulse validity is a window, never inverted.
ALTER TABLE "CsmPulse" ADD CONSTRAINT csmpulse_expires_after_created CHECK ("expiresAt" > "createdAt");
