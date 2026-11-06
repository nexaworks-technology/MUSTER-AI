-- M12 B5: pilot instrumentation events (spec §11). Internal, workspace-scoped, append-only.
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductEvent_workspaceId_id_key" ON "ProductEvent"("workspaceId", "id");
CREATE INDEX "ProductEvent_workspaceId_name_occurredAt_idx" ON "ProductEvent"("workspaceId", "name", "occurredAt");
CREATE INDEX "ProductEvent_workspaceId_membershipId_occurredAt_idx" ON "ProductEvent"("workspaceId", "membershipId", "occurredAt");

ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductEvent"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- Append-only, with the same single exception as AuditLog: the purge of a workspace whose deletion
-- grace period has ended (an uncancelled tombstone with graceEndsAt in the past). UPDATE is never
-- allowed. The cascade from Workspace/Membership deletes pass through this trigger too.
CREATE OR REPLACE FUNCTION product_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM "WorkspaceTombstone" t
    WHERE t."workspaceId" = OLD."workspaceId"
      AND t."cancelledAt" IS NULL
      AND t."graceEndsAt" <= now()
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ProductEvent is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER product_event_append_only
  BEFORE UPDATE OR DELETE ON "ProductEvent"
  FOR EACH ROW EXECUTE FUNCTION product_event_append_only();
