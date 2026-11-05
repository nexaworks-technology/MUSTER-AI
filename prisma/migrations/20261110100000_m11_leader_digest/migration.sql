-- M11 S7: the weekly Leader Reporter digest is delivered as in-app notifications (and Slack DMs).
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'LEADER_DIGEST';
ALTER TYPE "NotificationType" ADD VALUE 'LEADER_DIGEST_FAILED';
