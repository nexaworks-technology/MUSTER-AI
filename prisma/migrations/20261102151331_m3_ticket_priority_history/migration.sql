-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "openingPriority" "TicketPriority",
ADD COLUMN     "priorityChangedAt" TIMESTAMP(3);

-- D-64: priority as of a date. Existing rows: the current priority is the best known opening one.
UPDATE "Ticket" SET "openingPriority" = "priority" WHERE "openingPriority" IS NULL;

CREATE FUNCTION ticket_priority_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."openingPriority" IS NULL THEN NEW."openingPriority" := NEW."priority"; END IF;
  ELSIF NEW."priority" IS DISTINCT FROM OLD."priority"
    AND NEW."priorityChangedAt" IS NOT DISTINCT FROM OLD."priorityChangedAt" THEN
    NEW."priorityChangedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_priority_history BEFORE INSERT OR UPDATE ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_priority_history();
