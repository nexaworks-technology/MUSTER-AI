-- ─── OutcomeRecord: what happened to revenue after the flag (M7 B5, ARCHITECTURE §6.5, Q-15) ───
-- {status: RENEWED | EXPANDED | CONTRACTED | CHURNED, evidence[], occurredOn, attributed: true, note}.
-- Null until a renewal outcome or a revenue event falls inside the flag's 90-day window.
ALTER TABLE "OutcomeRecord" ADD COLUMN "revenueOutcome" JSONB;
