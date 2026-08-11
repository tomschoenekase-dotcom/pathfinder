BEGIN;

-- Additive, default-off evaluation execution lifecycle. This migration only
-- defines durable state; it does not enable or enqueue evaluation work.
CREATE TYPE "EvalRunStatus" AS ENUM ('LEGACY', 'STAGED', 'QUEUED', 'RETRY_SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

DROP TRIGGER "eval_runs_immutable" ON "eval_runs";
CREATE TRIGGER "eval_runs_no_delete"
  BEFORE DELETE ON "eval_runs"
  FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();

ALTER TABLE "eval_runs"
  ADD COLUMN "status" "EvalRunStatus" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER,
  ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "cancellation_requested_at" TIMESTAMP(3),
  ADD COLUMN "cancellation_requested_by" VARCHAR(191),
  ADD COLUMN "last_error_code" VARCHAR(100),
  ADD CONSTRAINT "eval_runs_attempt_bounds_check"
    CHECK (
      "attempt_number" >= 0
      AND ("max_attempts" IS NULL OR ("max_attempts" >= 1 AND "attempt_number" <= "max_attempts"))
    ),
  ADD CONSTRAINT "eval_runs_cancellation_pair_check"
    CHECK (("cancellation_requested_at" IS NULL) = ("cancellation_requested_by" IS NULL)),
  ADD CONSTRAINT "eval_runs_terminal_completion_check"
    CHECK (
      ("status" IN ('COMPLETED', 'FAILED', 'CANCELLED')) = ("completed_at" IS NOT NULL)
    ),
  ADD CONSTRAINT "eval_runs_started_execution_check"
    CHECK ("status" IN ('LEGACY', 'STAGED', 'QUEUED', 'RETRY_SCHEDULED', 'CANCELLED') OR "started_at" IS NOT NULL),
  ADD CONSTRAINT "eval_runs_error_code_check"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{0,99}$');

CREATE INDEX "eval_runs_status_created_at_idx" ON "eval_runs"("status", "created_at");

ALTER TABLE "eval_runs" ALTER COLUMN "status" SET DEFAULT 'STAGED';

CREATE FUNCTION "guard_eval_run_lifecycle_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (OLD."status" = 'LEGACY' AND NEW."status" = 'LEGACY') OR
    (OLD."status" = 'STAGED' AND NEW."status" IN ('QUEUED', 'CANCELLED')) OR
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'CANCELLED')) OR
    (OLD."status" = 'RETRY_SCHEDULED' AND NEW."status" IN ('RUNNING', 'CANCELLED')) OR
    (OLD."status" = 'RUNNING' AND NEW."status" IN ('RUNNING', 'RETRY_SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED')) OR
    (OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND NEW."status" = OLD."status")
  ) THEN
    RAISE EXCEPTION 'invalid evaluation run lifecycle transition';
  END IF;
  IF OLD."status" IN ('LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'terminal evaluation run status cannot change';
  END IF;
  IF OLD."status" IN ('LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED') AND ROW(
    NEW."attempt_number", NEW."max_attempts", NEW."started_at", NEW."completed_at",
    NEW."cancellation_requested_at", NEW."cancellation_requested_by", NEW."last_error_code"
  ) IS DISTINCT FROM ROW(
    OLD."attempt_number", OLD."max_attempts", OLD."started_at", OLD."completed_at",
    OLD."cancellation_requested_at", OLD."cancellation_requested_by", OLD."last_error_code"
  ) THEN
    RAISE EXCEPTION 'terminal evaluation run lifecycle evidence cannot change';
  END IF;
  IF NEW."attempt_number" < OLD."attempt_number" THEN
    RAISE EXCEPTION 'evaluation attempt number cannot decrease';
  END IF;
  IF NEW."status" = 'RUNNING' AND OLD."status" IN ('QUEUED', 'RETRY_SCHEDULED') THEN
    IF NEW."attempt_number" <> OLD."attempt_number" + 1 THEN
      RAISE EXCEPTION 'evaluation attempt claim must increment exactly once';
    END IF;
  ELSIF NEW."attempt_number" <> OLD."attempt_number" THEN
    RAISE EXCEPTION 'evaluation attempt number can change only during a claim';
  END IF;
  IF NEW."max_attempts" IS DISTINCT FROM OLD."max_attempts" AND NOT (
    OLD."max_attempts" IS NULL
    AND OLD."status" IN ('QUEUED', 'RETRY_SCHEDULED')
    AND NEW."status" = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'evaluation max attempts can be set only by the first claim';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
    RAISE EXCEPTION 'evaluation completion timestamp cannot change';
  END IF;
  IF OLD."started_at" IS NOT NULL AND NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
    RAISE EXCEPTION 'evaluation start timestamp cannot change';
  END IF;
  IF NEW."status" = 'RUNNING' AND NEW."started_at" IS NULL THEN
    RAISE EXCEPTION 'evaluation running state requires a start timestamp';
  END IF;
  IF OLD."cancellation_requested_at" IS NOT NULL AND (
    NEW."cancellation_requested_at" IS DISTINCT FROM OLD."cancellation_requested_at"
    OR NEW."cancellation_requested_by" IS DISTINCT FROM OLD."cancellation_requested_by"
  ) THEN
    RAISE EXCEPTION 'evaluation cancellation evidence cannot change';
  END IF;
  IF ROW(
    NEW."id", NEW."tenant_id", NEW."venue_id", NEW."idempotency_key",
    NEW."identity_hash", NEW."corpus_hash", NEW."prompt_contract_version",
    NEW."prompt_contract_hash", NEW."package_snapshot_ref", NEW."package_snapshot_hash",
    NEW."content_snapshot_version", NEW."content_snapshot_hash", NEW."model_provider",
    NEW."model_name", NEW."model_snapshot_hash", NEW."declared_budget_ceiling_e8_usd",
    NEW."created_by", NEW."trigger_type", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenant_id", OLD."venue_id", OLD."idempotency_key",
    OLD."identity_hash", OLD."corpus_hash", OLD."prompt_contract_version",
    OLD."prompt_contract_hash", OLD."package_snapshot_ref", OLD."package_snapshot_hash",
    OLD."content_snapshot_version", OLD."content_snapshot_hash", OLD."model_provider",
    OLD."model_name", OLD."model_snapshot_hash", OLD."declared_budget_ceiling_e8_usd",
    OLD."created_by", OLD."trigger_type", OLD."created_at"
  ) OR NEW."case_manifest_snapshot"::text IS DISTINCT FROM OLD."case_manifest_snapshot"::text
    OR NEW."model_snapshot"::text IS DISTINCT FROM OLD."model_snapshot"::text
    OR NEW."run_config_snapshot"::text IS DISTINCT FROM OLD."run_config_snapshot"::text
    OR NEW."identity_snapshot"::text IS DISTINCT FROM OLD."identity_snapshot"::text THEN
    RAISE EXCEPTION 'evaluation run identity columns cannot change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "eval_runs_lifecycle_transition_guard"
BEFORE UPDATE ON "eval_runs"
FOR EACH ROW EXECUTE FUNCTION "guard_eval_run_lifecycle_transition"();

COMMIT;
