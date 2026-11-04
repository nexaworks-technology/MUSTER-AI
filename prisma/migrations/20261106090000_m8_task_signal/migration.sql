-- AlterTable
ALTER TABLE "Task" ADD COLUMN "signalId" TEXT;

-- CreateIndex
CREATE INDEX "Task_workspaceId_signalId_idx" ON "Task"("workspaceId", "signalId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_signalId_fkey" FOREIGN KEY ("workspaceId", "signalId") REFERENCES "Signal"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
