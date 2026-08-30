BEGIN;

CREATE TYPE "AgentCostStatus" AS ENUM ('UNREPORTED', 'ESTIMATED', 'EXACT');

ALTER TABLE "agent_runs"
  ADD COLUMN "cost_status" "AgentCostStatus" NOT NULL DEFAULT 'UNREPORTED';

-- Existing non-zero run costs were produced from model estimates. Zero-cost
-- rows remain unreported because zero and unknown were previously conflated.
UPDATE "agent_runs"
  SET "cost_status" = 'ESTIMATED'
  WHERE "cost_e8_usd" > 0;

COMMIT;
