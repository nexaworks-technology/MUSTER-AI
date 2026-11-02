-- CreateEnum
CREATE TYPE "SignalCategory" AS ENUM ('USAGE', 'PEOPLE', 'SUPPORT', 'CALLS_EMAIL', 'MONEY', 'PROMISES', 'OUTSIDE');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SignalPolarity" AS ENUM ('RISK', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM');

-- CreateEnum
CREATE TYPE "OutcomeAction" AS ENUM ('ACTED', 'IGNORED', 'PENDING');

-- CreateTable
CREATE TABLE "SignalRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "polarity" "SignalPolarity" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "meaning" TEXT NOT NULL,
    "howDetected" TEXT NOT NULL,
    "typicalLeadTime" TEXT NOT NULL,
    "falseAlarmCauses" TEXT NOT NULL,
    "dormantReason" TEXT,
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "severity" "SignalSeverity" NOT NULL,
    "polarity" "SignalPolarity" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "episode" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" DATE NOT NULL,
    "lastSeenAt" DATE NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedReason" TEXT,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "markedFalseById" TEXT,
    "markedFalseAt" TIMESTAMP(3),
    "falseAlarmReason" TEXT,
    "falseAlarmValues" JSONB,
    "origin" "RecordOrigin" NOT NULL DEFAULT 'SYSTEM',
    "agentRunId" TEXT,
    "publicSourceUrl" TEXT,
    "publicSourceDate" DATE,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "signalId" TEXT,
    "agentRunId" TEXT,
    "flagType" "SignalPolarity" NOT NULL,
    "flaggedAt" TIMESTAMP(3) NOT NULL,
    "arrAtFlagMinor" BIGINT,
    "arrCurrency" CHAR(3),
    "actionTaken" "OutcomeAction" NOT NULL DEFAULT 'PENDING',
    "actionRefs" JSONB NOT NULL DEFAULT '[]',
    "firstActionAt" TIMESTAMP(3),
    "d7Outcome" JSONB,
    "d30Outcome" JSONB,
    "d90Outcome" JSONB,
    "valueSavedMinor" BIGINT,
    "valueExpandedMinor" BIGINT,
    "isTrueAlarm" BOOLEAN,
    "csmAgreed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutcomeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignalRule_workspaceId_id_key" ON "SignalRule"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SignalRule_workspaceId_ruleKey_key" ON "SignalRule"("workspaceId", "ruleKey");

-- CreateIndex
CREATE INDEX "Signal_workspaceId_status_severity_idx" ON "Signal"("workspaceId", "status", "severity");

-- CreateIndex
CREATE INDEX "Signal_workspaceId_accountId_firstSeenAt_idx" ON "Signal"("workspaceId", "accountId", "firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_workspaceId_id_key" ON "Signal"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_workspaceId_dedupeKey_episode_key" ON "Signal"("workspaceId", "dedupeKey", "episode");

-- CreateIndex
CREATE INDEX "OutcomeRecord_workspaceId_flaggedAt_idx" ON "OutcomeRecord"("workspaceId", "flaggedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutcomeRecord_workspaceId_id_key" ON "OutcomeRecord"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutcomeRecord_workspaceId_signalId_key" ON "OutcomeRecord"("workspaceId", "signalId");

-- AddForeignKey
ALTER TABLE "SignalRule" ADD CONSTRAINT "SignalRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalRule" ADD CONSTRAINT "SignalRule_workspaceId_updatedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "updatedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_acknowledgedById_fkey" FOREIGN KEY ("workspaceId", "acknowledgedById") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_markedFalseById_fkey" FOREIGN KEY ("workspaceId", "markedFalseById") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeRecord" ADD CONSTRAINT "OutcomeRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeRecord" ADD CONSTRAINT "OutcomeRecord_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeRecord" ADD CONSTRAINT "OutcomeRecord_workspaceId_signalId_fkey" FOREIGN KEY ("workspaceId", "signalId") REFERENCES "Signal"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "SignalRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignalRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SignalRule"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Signal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Signal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Signal"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
ALTER TABLE "Signal" ADD CONSTRAINT signal_agent_run_required
  CHECK ("origin" <> 'AI' OR "agentRunId" IS NOT NULL);

ALTER TABLE "OutcomeRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutcomeRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OutcomeRecord"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- ─── Signals: records with a lifecycle (M3 rule 8, ARCHITECTURE §3.2) ───

-- Every signal names its evidence.
ALTER TABLE "Signal" ADD CONSTRAINT signal_evidence_required
  CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1);

-- Outside signals come only from a dated public source (INTERP-6).
ALTER TABLE "Signal" ADD CONSTRAINT signal_outside_has_public_source
  CHECK (category <> 'OUTSIDE' OR ("publicSourceUrl" IS NOT NULL AND "publicSourceDate" IS NOT NULL));

-- At most one live (open or acknowledged) episode per dedupe key: re-runs cannot duplicate (D-57).
CREATE UNIQUE INDEX "Signal_one_live_episode" ON "Signal" ("workspaceId", "dedupeKey")
  WHERE status IN ('OPEN', 'ACKNOWLEDGED');

ALTER TABLE "Signal" ADD CONSTRAINT signal_episode_positive CHECK (episode >= 1);

-- A dormant rule (no data source yet, D-61) cannot be enabled.
ALTER TABLE "SignalRule" ADD CONSTRAINT signalrule_dormant_disabled
  CHECK ("dormantReason" IS NULL OR enabled = false);
