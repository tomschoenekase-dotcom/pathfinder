CREATE TYPE "ProspectResearchJobStatus" AS ENUM (
  'QUEUED', 'CLAIMED', 'RESEARCHED', 'NEEDS_REVIEW', 'BLOCKED', 'CAP_REACHED', 'SKIPPED'
);
CREATE TYPE "ProspectResearchAttemptStatus" AS ENUM ('CLAIMED', 'COMPLETED', 'RELEASED', 'EXPIRED');

CREATE TABLE "prospect_research_jobs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "status" "ProspectResearchJobStatus" NOT NULL DEFAULT 'QUEUED',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "claim_token" UUID,
  "claim_owner_id" VARCHAR(191),
  "claim_agent_run_id" VARCHAR(191),
  "claim_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "terminal_reason" VARCHAR(2000),
  "queued_by" VARCHAR(191) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_research_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_research_jobs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "prospect_research_jobs_organization_id_key" ON "prospect_research_jobs"("organization_id");
CREATE UNIQUE INDEX "prospect_research_jobs_claim_token_key" ON "prospect_research_jobs"("claim_token");
CREATE INDEX "prospect_research_jobs_claim_idx"
  ON "prospect_research_jobs"("status", "priority", "claim_expires_at", "created_at");

CREATE TABLE "prospect_research_attempts" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "claim_token" UUID NOT NULL,
  "agent_run_id" VARCHAR(191) NOT NULL,
  "agent_identity_id" VARCHAR(191) NOT NULL,
  "model_provider" VARCHAR(191),
  "model_name" VARCHAR(191),
  "prompt_identity" VARCHAR(191) NOT NULL,
  "status" "ProspectResearchAttemptStatus" NOT NULL DEFAULT 'CLAIMED',
  "outcome" "ProspectResearchJobStatus",
  "outcome_reason" VARCHAR(2000),
  "usage" JSONB NOT NULL DEFAULT '{}',
  "cost_usd" DECIMAL(12,6),
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "prospect_research_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_research_attempts_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "prospect_research_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "prospect_research_attempts_claim_token_key" ON "prospect_research_attempts"("claim_token");
CREATE INDEX "prospect_research_attempts_job_time_idx" ON "prospect_research_attempts"("job_id", "claimed_at");
CREATE INDEX "prospect_research_attempts_run_status_idx"
  ON "prospect_research_attempts"("agent_run_id", "status", "claimed_at");
