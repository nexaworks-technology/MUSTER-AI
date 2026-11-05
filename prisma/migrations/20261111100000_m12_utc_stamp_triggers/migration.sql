-- Q-81: the M3 stamp triggers assigned now() to TIMESTAMP(3) (no zone) columns, which stores the
-- session's local clock on a database whose TimeZone is not UTC. Prisma then reads it as UTC.
-- Convert explicitly, as M9's title trigger (20261107110000) does. Logic is otherwise unchanged.
CREATE OR REPLACE FUNCTION contact_status_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' AND NEW."statusChangedAt" IS NULL THEN
      NEW."statusChangedAt" := (now() AT TIME ZONE 'UTC');
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status"
    AND NEW."statusChangedAt" IS NOT DISTINCT FROM OLD."statusChangedAt" THEN
    NEW."statusChangedAt" := (now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ticket_escalated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."isEscalated" AND NEW."escalatedAt" IS NULL THEN
      NEW."escalatedAt" := (now() AT TIME ZONE 'UTC');
    END IF;
  ELSIF NEW."isEscalated" AND NOT OLD."isEscalated"
    AND NEW."escalatedAt" IS NOT DISTINCT FROM OLD."escalatedAt" THEN
    NEW."escalatedAt" := (now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ticket_priority_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."openingPriority" IS NULL THEN NEW."openingPriority" := NEW."priority"; END IF;
  ELSIF NEW."priority" IS DISTINCT FROM OLD."priority"
    AND NEW."priorityChangedAt" IS NOT DISTINCT FROM OLD."priorityChangedAt" THEN
    NEW."priorityChangedAt" := (now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NEW;
END $$;
