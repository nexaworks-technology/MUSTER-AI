-- CreateTable
CREATE TABLE "VoiceSample" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "outboundMessageId" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "approvedForVoice" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceSample_workspaceId_id_key" ON "VoiceSample"("workspaceId", "id");
CREATE INDEX "VoiceSample_workspaceId_approvedForVoice_idx" ON "VoiceSample"("workspaceId", "approvedForVoice");

-- AddForeignKey
ALTER TABLE "VoiceSample" ADD CONSTRAINT "VoiceSample_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceSample" ADD CONSTRAINT "VoiceSample_workspaceId_outboundMessageId_fkey" FOREIGN KEY ("workspaceId", "outboundMessageId") REFERENCES "OutboundMessage"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VoiceSample" ADD CONSTRAINT "VoiceSample_workspaceId_createdById_fkey" FOREIGN KEY ("workspaceId", "createdById") REFERENCES "Membership"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enable RLS & Force RLS
ALTER TABLE "VoiceSample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VoiceSample" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "VoiceSample" FOR ALL USING ("workspaceId" = current_setting('app.workspace_id', true)) WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
