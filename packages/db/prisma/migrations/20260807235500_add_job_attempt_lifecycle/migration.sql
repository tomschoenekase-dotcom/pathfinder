CREATE TYPE "JobFailureDisposition" AS ENUM (
  'RETRY_ELIGIBLE',
  'ATTEMPTS_EXHAUSTED',
  'UNRECOVERABLE'
);

ALTER TABLE "job_records"
  ADD COLUMN "attempt_number" INTEGER,
  ADD COLUMN "max_attempts" INTEGER,
  ADD COLUMN "failure_disposition" "JobFailureDisposition",
  ADD COLUMN "terminal_at" TIMESTAMP(3),
  ADD CONSTRAINT "job_records_attempt_bounds_check" CHECK (
    ("attempt_number" IS NULL AND "max_attempts" IS NULL)
    OR (
      "attempt_number" >= 1
      AND "max_attempts" >= 1
      AND "attempt_number" <= "max_attempts"
    )
  ),
  ADD CONSTRAINT "job_records_failure_lifecycle_check" CHECK (
    ("failure_disposition" IS NULL AND "terminal_at" IS NULL)
    OR (
      "status" = 'FAILED'
      AND "failure_disposition" = 'RETRY_ELIGIBLE'
      AND "terminal_at" IS NULL
    )
    OR (
      "status" = 'FAILED'
      AND "failure_disposition" IN ('ATTEMPTS_EXHAUSTED', 'UNRECOVERABLE')
      AND "terminal_at" IS NOT NULL
    )
  );

CREATE INDEX "job_records_status_failure_disposition_terminal_at_idx"
  ON "job_records"("status", "failure_disposition", "terminal_at");
