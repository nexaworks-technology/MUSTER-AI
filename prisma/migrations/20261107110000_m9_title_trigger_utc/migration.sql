-- The title-change stamp is a UTC clock reading. The column is TIMESTAMP(3) (no zone), so assigning
-- now() directly stores the session's local clock on a server whose time zone is not UTC, which
-- Prisma then reads as UTC. Convert explicitly.
CREATE OR REPLACE FUNCTION contact_title_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."title" IS NOT NULL AND NEW."title" IS DISTINCT FROM OLD."title"
    AND NEW."titleChangedAt" IS NOT DISTINCT FROM OLD."titleChangedAt" THEN
    NEW."previousTitle" := OLD."title";
    NEW."titleChangedAt" := (now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END $$;
