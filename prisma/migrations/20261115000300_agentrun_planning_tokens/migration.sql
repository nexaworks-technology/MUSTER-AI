-- Ask AI's planning calls (tool selection, run before the answer) were not counted anywhere a
-- budget could see. They are recorded on the answer's run, apart from the answer's own tokens.
ALTER TABLE "AgentRun" ADD COLUMN "planningInputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRun" ADD COLUMN "planningOutputTokens" INTEGER NOT NULL DEFAULT 0;
