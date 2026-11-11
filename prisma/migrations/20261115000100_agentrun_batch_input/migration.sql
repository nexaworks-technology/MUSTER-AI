-- The input payload (ids only) of a run submitted as a batch, so its records can be rebuilt and
-- checked when the batch result is collected later.
ALTER TABLE "AgentRun" ADD COLUMN "batchInput" JSONB;
