-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'FAILED', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "RevenueEventType" AS ENUM ('NEW', 'EXPANSION', 'CONTRACTION', 'CHURN', 'REACTIVATION');

-- CreateEnum
CREATE TYPE "ComputedBy" AS ENUM ('RULE');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "renewalDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "renewalDate" TIMESTAMP(3),
    "autoRenew" BOOLEAN,
    "noticePeriodDays" INTEGER,
    "valueMinor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "seatsPurchased" INTEGER,
    "creditsPurchased" INTEGER,
    "termsEnc" TEXT,
    "pricingNotesEnc" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "documentFileId" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contractId" TEXT,
    "plan" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "number" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "RevenueEventType" NOT NULL,
    "deltaArrMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "computedBy" "ComputedBy" NOT NULL DEFAULT 'RULE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contract_workspaceId_accountId_startDate_idx" ON "Contract"("workspaceId", "accountId", "startDate");

-- CreateIndex
CREATE INDEX "Contract_workspaceId_renewalDate_idx" ON "Contract"("workspaceId", "renewalDate");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_workspaceId_id_key" ON "Contract"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Subscription_workspaceId_accountId_idx" ON "Subscription"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_workspaceId_id_key" ON "Subscription"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_status_dueAt_idx" ON "Invoice"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_accountId_issuedAt_idx" ON "Invoice"("workspaceId", "accountId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_workspaceId_id_key" ON "Invoice"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "RevenueEvent_workspaceId_effectiveDate_idx" ON "RevenueEvent"("workspaceId", "effectiveDate");

-- CreateIndex
CREATE INDEX "RevenueEvent_workspaceId_accountId_idx" ON "RevenueEvent"("workspaceId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_workspaceId_id_key" ON "RevenueEvent"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_workspaceId_sourceType_sourceId_type_key" ON "RevenueEvent"("workspaceId", "sourceType", "sourceId", "type");

-- CreateIndex
CREATE INDEX "Account_workspaceId_renewalDate_idx" ON "Account"("workspaceId", "renewalDate");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_contractId_fkey" FOREIGN KEY ("workspaceId", "contractId") REFERENCES "Contract"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_subscriptionId_fkey" FOREIGN KEY ("workspaceId", "subscriptionId") REFERENCES "Subscription"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS for [W] tables (prisma/sql/rls.ts) ───
ALTER TABLE "Contract" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contract" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Contract"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Subscription"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Invoice"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "RevenueEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RevenueEvent"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
