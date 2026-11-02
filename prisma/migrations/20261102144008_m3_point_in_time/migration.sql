-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- D-56: record when a fact became true, for every writer (services, CSV import, connectors).
-- An explicit value wins; an unchanged re-write leaves the stamp alone.
CREATE FUNCTION contact_status_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' AND NEW."statusChangedAt" IS NULL THEN
      NEW."statusChangedAt" := now();
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status"
    AND NEW."statusChangedAt" IS NOT DISTINCT FROM OLD."statusChangedAt" THEN
    NEW."statusChangedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_status_changed_at BEFORE INSERT OR UPDATE ON "Contact"
  FOR EACH ROW EXECUTE FUNCTION contact_status_changed_at();

CREATE FUNCTION ticket_escalated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."isEscalated" AND NEW."escalatedAt" IS NULL THEN
      NEW."escalatedAt" := now();
    END IF;
  ELSIF NEW."isEscalated" AND NOT OLD."isEscalated"
    AND NEW."escalatedAt" IS NOT DISTINCT FROM OLD."escalatedAt" THEN
    NEW."escalatedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_escalated_at BEFORE INSERT OR UPDATE ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_escalated_at();
