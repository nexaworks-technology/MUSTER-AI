-- CreateTable
CREATE TABLE "UsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "events" INTEGER NOT NULL,
    "seatsUsed" INTEGER,
    "creditsUsed" INTEGER,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserUsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "externalUserId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "events" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureUsageDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "users" INTEGER NOT NULL,
    "events" INTEGER NOT NULL,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureCatalog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isKeyFeature" BOOLEAN NOT NULL DEFAULT false,
    "includedInPlans" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageDaily_workspaceId_id_key" ON "UsageDaily"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDaily_workspaceId_accountId_date_key" ON "UsageDaily"("workspaceId", "accountId", "date");

-- CreateIndex
CREATE INDEX "UserUsageDaily_workspaceId_accountId_date_idx" ON "UserUsageDaily"("workspaceId", "accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "UserUsageDaily_workspaceId_id_key" ON "UserUsageDaily"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UserUsageDaily_workspaceId_accountId_externalUserId_date_key" ON "UserUsageDaily"("workspaceId", "accountId", "externalUserId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureUsageDaily_workspaceId_id_key" ON "FeatureUsageDaily"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureUsageDaily_workspaceId_accountId_featureKey_date_key" ON "FeatureUsageDaily"("workspaceId", "accountId", "featureKey", "date");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureCatalog_workspaceId_id_key" ON "FeatureCatalog"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureCatalog_workspaceId_featureKey_key" ON "FeatureCatalog"("workspaceId", "featureKey");

-- AddForeignKey
ALTER TABLE "UsageDaily" ADD CONSTRAINT "UsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageDaily" ADD CONSTRAINT "UsageDaily_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserUsageDaily" ADD CONSTRAINT "UserUsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserUsageDaily" ADD CONSTRAINT "UserUsageDaily_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserUsageDaily" ADD CONSTRAINT "UserUsageDaily_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureUsageDaily" ADD CONSTRAINT "FeatureUsageDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureUsageDaily" ADD CONSTRAINT "FeatureUsageDaily_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureCatalog" ADD CONSTRAINT "FeatureCatalog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "UsageDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageDaily" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UsageDaily"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "UserUsageDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserUsageDaily" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserUsageDaily"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "FeatureUsageDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeatureUsageDaily" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FeatureUsageDaily"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "FeatureCatalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeatureCatalog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FeatureCatalog"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
