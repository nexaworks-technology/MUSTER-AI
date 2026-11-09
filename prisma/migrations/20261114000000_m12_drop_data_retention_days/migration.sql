-- Drop dataRetentionDays column from Workspace (Q-91: unused column removed)
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "dataRetentionDays";
