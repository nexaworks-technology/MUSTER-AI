-- M12 B2: workspace deletion with a grace period (§6N7, Q-10).
CREATE TABLE "WorkspaceTombstone" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "requestedByUserId" TEXT,
    "graceEndsAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "purgeCounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceTombstone_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkspaceTombstone_workspaceId_key" ON "WorkspaceTombstone"("workspaceId");

-- AuditLog stays append-only. The single exception is the purge of a workspace whose deletion
-- grace period has ended (an uncancelled tombstone with graceEndsAt in the past). UPDATE is never
-- allowed.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "WorkspaceTombstone" t
    WHERE t."workspaceId" = OLD."workspaceId"
      AND t."cancelledAt" IS NULL
      AND t."graceEndsAt" <= now()
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
