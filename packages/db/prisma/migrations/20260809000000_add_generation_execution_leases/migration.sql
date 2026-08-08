ALTER TABLE "answer_analysis_snapshots"
  ADD COLUMN "execution_lease_token" UUID,
  ADD COLUMN "execution_lease_expires_at" TIMESTAMP(3),
  ADD CONSTRAINT "answer_analysis_snapshots_execution_lease_state_check" CHECK (
    ("execution_lease_token" IS NULL AND "execution_lease_expires_at" IS NULL)
    OR
    ("execution_lease_token" IS NOT NULL AND "execution_lease_expires_at" IS NOT NULL)
  );

ALTER TABLE "weekly_reports"
  ADD COLUMN "execution_lease_token" UUID,
  ADD COLUMN "execution_lease_expires_at" TIMESTAMP(3),
  ADD CONSTRAINT "weekly_reports_execution_lease_state_check" CHECK (
    ("execution_lease_token" IS NULL AND "execution_lease_expires_at" IS NULL)
    OR
    ("execution_lease_token" IS NOT NULL AND "execution_lease_expires_at" IS NOT NULL)
  );

CREATE INDEX "answer_analysis_snapshots_status_execution_lease_expires_at_idx"
  ON "answer_analysis_snapshots"("status", "execution_lease_expires_at");

CREATE INDEX "weekly_reports_status_execution_lease_expires_at_idx"
  ON "weekly_reports"("status", "execution_lease_expires_at");
