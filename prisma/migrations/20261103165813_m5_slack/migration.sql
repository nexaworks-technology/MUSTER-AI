-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SIGNAL_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'DAILY_DIGEST';

-- A Slack delivery is recorded once per (recipient, type, thing): a retried job or two workers
-- racing insert nothing the second time and therefore post nothing twice (M5, D-95).
CREATE UNIQUE INDEX notification_slack_once
  ON "Notification" ("workspaceId", "recipientMembershipId", "type", "refType", "refId")
  WHERE "channel" = 'SLACK';
