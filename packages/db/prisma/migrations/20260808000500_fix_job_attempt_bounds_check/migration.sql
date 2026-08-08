ALTER TABLE "job_records"
  DROP CONSTRAINT "job_records_attempt_bounds_check",
  ADD CONSTRAINT "job_records_attempt_bounds_check" CHECK (
    ("attempt_number" IS NULL AND "max_attempts" IS NULL)
    OR (
      "attempt_number" IS NOT NULL
      AND "max_attempts" IS NOT NULL
      AND "attempt_number" >= 1
      AND "max_attempts" >= 1
      AND "attempt_number" <= "max_attempts"
    )
  );
