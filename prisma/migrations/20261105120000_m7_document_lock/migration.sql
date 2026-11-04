-- ─── Document: locked metrics cannot change once locked (M7 B3) ──────────────────────────
-- `metrics` is a computed snapshot taken by code. Once `lockedAt` is set the snapshot and the lock
-- itself are immutable; only the narrative (text with {{metric.key}} placeholders) can be edited.
CREATE FUNCTION document_metrics_locked() RETURNS trigger AS $$
BEGIN
  IF OLD."lockedAt" IS NOT NULL
     AND (NEW."metrics" IS DISTINCT FROM OLD."metrics" OR NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt") THEN
    RAISE EXCEPTION 'Document metrics are locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_metrics_locked
  BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION document_metrics_locked();
