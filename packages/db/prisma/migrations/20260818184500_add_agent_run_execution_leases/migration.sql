ALTER TABLE "agent_runs"
  ADD COLUMN "execution_lease_token" UUID,
  ADD COLUMN "execution_lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "last_heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3;

CREATE INDEX "agent_runs_status_lease_expiry_idx"
  ON "agent_runs"("status", "execution_lease_expires_at");
