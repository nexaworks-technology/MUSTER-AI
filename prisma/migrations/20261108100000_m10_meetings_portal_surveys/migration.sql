-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'PRE_CALL_BRIEF';

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'CALL_TRANSCRIPT';

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "ownerMembershipId" DROP NOT NULL;

-- AlterEnum
ALTER TYPE "RecordSource" ADD VALUE 'GOOGLE_CALENDAR';
ALTER TYPE "RecordSource" ADD VALUE 'MICROSOFT_CALENDAR';
ALTER TYPE "RecordSource" ADD VALUE 'FIREFLIES';
ALTER TYPE "RecordSource" ADD VALUE 'GONG';
ALTER TYPE "RecordSource" ADD VALUE 'ZOOM';

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'GOOGLE_CALENDAR';
ALTER TYPE "IntegrationProvider" ADD VALUE 'MICROSOFT_CALENDAR';
ALTER TYPE "IntegrationProvider" ADD VALUE 'FIREFLIES';
ALTER TYPE "IntegrationProvider" ADD VALUE 'GONG';
ALTER TYPE "IntegrationProvider" ADD VALUE 'ZOOM';

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendeeResponseStatus" AS ENUM ('NEEDS_ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE');

-- CreateEnum
CREATE TYPE "SuccessPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SurveyType" AS ENUM ('NPS', 'CSAT', 'CES');

-- CreateEnum
CREATE TYPE "SurveyTrigger" AS ENUM ('ONBOARDING_VALUE_REACHED', 'TICKET_CLOSED', 'RENEWAL_WINDOW_60', 'MANUAL');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "organizerUserId" TEXT,
    "conversationId" TEXT,
    "briefDocumentId" TEXT,
    "summaryAgentRunId" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'MANUAL',
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingAttendee" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "contactId" TEXT,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "responseStatus" "AttendeeResponseStatus" NOT NULL DEFAULT 'NEEDS_ACTION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuccessPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SuccessPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sharedWithPortal" BOOLEAN NOT NULL DEFAULT false,
    "milestones" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuccessPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "SurveyType" NOT NULL,
    "trigger" "SurveyTrigger" NOT NULL,
    "question" TEXT NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "token" TEXT,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalAccess" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_workspaceId_id_key" ON "Meeting"("workspaceId", "id");
CREATE INDEX "Meeting_workspaceId_accountId_startsAt_idx" ON "Meeting"("workspaceId", "accountId", "startsAt");
CREATE INDEX "Meeting_workspaceId_startsAt_idx" ON "Meeting"("workspaceId", "startsAt");
CREATE INDEX "Meeting_workspaceId_source_externalId_idx" ON "Meeting"("workspaceId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAttendee_workspaceId_id_key" ON "MeetingAttendee"("workspaceId", "id");
CREATE UNIQUE INDEX "MeetingAttendee_workspaceId_meetingId_email_key" ON "MeetingAttendee"("workspaceId", "meetingId", "email");
CREATE INDEX "MeetingAttendee_workspaceId_meetingId_idx" ON "MeetingAttendee"("workspaceId", "meetingId");
CREATE INDEX "MeetingAttendee_workspaceId_contactId_idx" ON "MeetingAttendee"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "SuccessPlan_workspaceId_id_key" ON "SuccessPlan"("workspaceId", "id");
CREATE INDEX "SuccessPlan_workspaceId_accountId_idx" ON "SuccessPlan"("workspaceId", "accountId");

-- CreateIndex
CREATE INDEX "Goal_workspaceId_successPlanId_idx" ON "Goal"("workspaceId", "successPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "Survey_workspaceId_id_key" ON "Survey"("workspaceId", "id");
CREATE INDEX "Survey_workspaceId_type_status_idx" ON "Survey"("workspaceId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyResponse_workspaceId_id_key" ON "SurveyResponse"("workspaceId", "id");
CREATE UNIQUE INDEX "SurveyResponse_workspaceId_token_key" ON "SurveyResponse"("workspaceId", "token");
CREATE INDEX "SurveyResponse_workspaceId_accountId_respondedAt_idx" ON "SurveyResponse"("workspaceId", "accountId", "respondedAt");
CREATE INDEX "SurveyResponse_workspaceId_surveyId_idx" ON "SurveyResponse"("workspaceId", "surveyId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalAccess_workspaceId_id_key" ON "PortalAccess"("workspaceId", "id");
CREATE UNIQUE INDEX "PortalAccess_workspaceId_tokenHash_key" ON "PortalAccess"("workspaceId", "tokenHash");
CREATE INDEX "PortalAccess_workspaceId_accountId_idx" ON "PortalAccess"("workspaceId", "accountId");
CREATE INDEX "PortalAccess_workspaceId_contactId_idx" ON "PortalAccess"("workspaceId", "contactId");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_organizerUserId_fkey" FOREIGN KEY ("organizerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_briefDocumentId_fkey" FOREIGN KEY ("workspaceId", "briefDocumentId") REFERENCES "Document"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_summaryAgentRunId_fkey" FOREIGN KEY ("workspaceId", "summaryAgentRunId") REFERENCES "AgentRun"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_workspaceId_meetingId_fkey" FOREIGN KEY ("workspaceId", "meetingId") REFERENCES "Meeting"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MeetingAttendee" ADD CONSTRAINT "MeetingAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuccessPlan" ADD CONSTRAINT "SuccessPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SuccessPlan" ADD CONSTRAINT "SuccessPlan_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_workspaceId_successPlanId_fkey" FOREIGN KEY ("workspaceId", "successPlanId") REFERENCES "SuccessPlan"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_workspaceId_surveyId_fkey" FOREIGN KEY ("workspaceId", "surveyId") REFERENCES "Survey"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalAccess" ADD CONSTRAINT "PortalAccess_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalAccess" ADD CONSTRAINT "PortalAccess_workspaceId_accountId_fkey" FOREIGN KEY ("workspaceId", "accountId") REFERENCES "Account"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalAccess" ADD CONSTRAINT "PortalAccess_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security (ARCHITECTURE §3.2, D-03)
ALTER TABLE "Meeting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Meeting" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Meeting"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "MeetingAttendee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MeetingAttendee" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MeetingAttendee"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "SuccessPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SuccessPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SuccessPlan"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "Survey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Survey" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Survey"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "SurveyResponse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SurveyResponse" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SurveyResponse"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "PortalAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortalAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PortalAccess"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
