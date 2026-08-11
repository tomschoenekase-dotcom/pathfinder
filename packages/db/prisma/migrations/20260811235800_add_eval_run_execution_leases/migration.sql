BEGIN;

ALTER TABLE "eval_runs"
  ADD COLUMN "execution_lease_token" UUID,
  ADD COLUMN "execution_lease_expires_at" TIMESTAMP(3),
  ADD CONSTRAINT "eval_runs_execution_lease_pair_check"
    CHECK (("execution_lease_token" IS NULL) = ("execution_lease_expires_at" IS NULL)),
  ADD CONSTRAINT "eval_runs_execution_lease_state_check"
    CHECK (("status" = 'RUNNING') = ("execution_lease_token" IS NOT NULL));

ALTER TABLE "eval_run_cost_reservations"
  ADD COLUMN "lease_token" UUID;

CREATE FUNCTION "guard_eval_reservation_lease_token"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."lease_token" IS NULL THEN
    RAISE EXCEPTION 'new evaluation reservation requires a fenced lease token';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."lease_token" IS DISTINCT FROM OLD."lease_token" THEN
    RAISE EXCEPTION 'evaluation reservation lease token cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "eval_run_cost_reservations_lease_token_guard"
BEFORE INSERT OR UPDATE ON "eval_run_cost_reservations"
FOR EACH ROW EXECUTE FUNCTION "guard_eval_reservation_lease_token"();

CREATE INDEX "eval_runs_expired_execution_lease_idx"
  ON "eval_runs"("execution_lease_expires_at", "created_at") WHERE "status" = 'RUNNING';

CREATE FUNCTION "guard_eval_run_execution_lease"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
     AND NEW."execution_lease_token" IS DISTINCT FROM OLD."execution_lease_token" THEN
    IF OLD."execution_lease_expires_at" > CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'active evaluation execution lease cannot be taken over';
    END IF;
    IF NEW."attempt_number" NOT IN (OLD."attempt_number", OLD."attempt_number" + 1) THEN
      RAISE EXCEPTION 'evaluation lease takeover attempt is not fenced';
    END IF;
  ELSIF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
    AND NEW."execution_lease_token" IS NOT DISTINCT FROM OLD."execution_lease_token"
    AND NEW."execution_lease_expires_at" IS DISTINCT FROM OLD."execution_lease_expires_at" THEN
    IF OLD."execution_lease_expires_at" <= CURRENT_TIMESTAMP
       OR NEW."execution_lease_expires_at" <= OLD."execution_lease_expires_at"
       OR NEW."execution_lease_expires_at" > CURRENT_TIMESTAMP + INTERVAL '15 minutes 1 second' THEN
      RAISE EXCEPTION 'evaluation execution lease renewal is outside fenced bounds';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "eval_runs_execution_lease_guard" BEFORE UPDATE ON "eval_runs"
FOR EACH ROW EXECUTE FUNCTION "guard_eval_run_execution_lease"();

-- The original lifecycle guard allowed attempt increments only while entering
-- RUNNING. Lease takeover is the sole additional RUNNING-to-RUNNING increment.
CREATE OR REPLACE FUNCTION "guard_eval_run_lifecycle_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (OLD."status" = 'LEGACY' AND NEW."status" = 'LEGACY') OR
    (OLD."status" = 'STAGED' AND NEW."status" IN ('QUEUED', 'CANCELLED')) OR
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'CANCELLED')) OR
    (OLD."status" = 'RETRY_SCHEDULED' AND NEW."status" IN ('RUNNING', 'FAILED', 'CANCELLED')) OR
    (OLD."status" = 'RUNNING' AND NEW."status" IN ('RUNNING', 'RETRY_SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED')) OR
    (OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND NEW."status" = OLD."status")
  ) THEN RAISE EXCEPTION 'invalid evaluation run lifecycle transition'; END IF;
  IF OLD."status" IN ('LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED') AND ROW(
    NEW."attempt_number", NEW."max_attempts", NEW."started_at", NEW."completed_at",
    NEW."cancellation_requested_at", NEW."cancellation_requested_by", NEW."last_error_code",
    NEW."execution_lease_token", NEW."execution_lease_expires_at"
  ) IS DISTINCT FROM ROW(
    OLD."attempt_number", OLD."max_attempts", OLD."started_at", OLD."completed_at",
    OLD."cancellation_requested_at", OLD."cancellation_requested_by", OLD."last_error_code",
    OLD."execution_lease_token", OLD."execution_lease_expires_at"
  ) THEN RAISE EXCEPTION 'terminal evaluation run lifecycle evidence cannot change'; END IF;
  IF NEW."attempt_number" < OLD."attempt_number" THEN RAISE EXCEPTION 'evaluation attempt number cannot decrease'; END IF;
  IF NEW."status" = 'RUNNING' AND OLD."status" IN ('QUEUED', 'RETRY_SCHEDULED') THEN
    IF NEW."attempt_number" <> OLD."attempt_number" + 1 THEN RAISE EXCEPTION 'evaluation attempt claim must increment exactly once'; END IF;
  ELSIF OLD."status" = 'RUNNING' AND NEW."status" = 'RUNNING'
    AND OLD."execution_lease_expires_at" <= CURRENT_TIMESTAMP
    AND NEW."execution_lease_token" IS DISTINCT FROM OLD."execution_lease_token" THEN
    IF NEW."attempt_number" NOT IN (OLD."attempt_number", OLD."attempt_number" + 1) THEN RAISE EXCEPTION 'evaluation lease takeover attempt is invalid'; END IF;
  ELSIF NEW."attempt_number" <> OLD."attempt_number" THEN RAISE EXCEPTION 'evaluation attempt number can change only during a claim'; END IF;
  IF NEW."max_attempts" IS DISTINCT FROM OLD."max_attempts" AND NOT (
    OLD."max_attempts" IS NULL AND OLD."status" IN ('QUEUED', 'RETRY_SCHEDULED') AND NEW."status" = 'RUNNING'
  ) THEN RAISE EXCEPTION 'evaluation max attempts can be set only by the first claim'; END IF;
  IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN RAISE EXCEPTION 'evaluation completion timestamp cannot change'; END IF;
  IF OLD."started_at" IS NOT NULL AND NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN RAISE EXCEPTION 'evaluation start timestamp cannot change'; END IF;
  IF OLD."cancellation_requested_at" IS NOT NULL AND ROW(NEW."cancellation_requested_at", NEW."cancellation_requested_by") IS DISTINCT FROM ROW(OLD."cancellation_requested_at", OLD."cancellation_requested_by") THEN RAISE EXCEPTION 'evaluation cancellation evidence cannot change'; END IF;
  IF ROW(NEW."id", NEW."tenant_id", NEW."venue_id", NEW."idempotency_key", NEW."identity_hash", NEW."corpus_hash",
    NEW."prompt_contract_version", NEW."prompt_contract_hash", NEW."package_snapshot_ref", NEW."package_snapshot_hash",
    NEW."content_snapshot_version", NEW."content_snapshot_hash", NEW."model_provider", NEW."model_name", NEW."model_snapshot_hash",
    NEW."declared_budget_ceiling_e8_usd", NEW."created_by", NEW."trigger_type", NEW."created_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."tenant_id", OLD."venue_id", OLD."idempotency_key", OLD."identity_hash", OLD."corpus_hash",
    OLD."prompt_contract_version", OLD."prompt_contract_hash", OLD."package_snapshot_ref", OLD."package_snapshot_hash",
    OLD."content_snapshot_version", OLD."content_snapshot_hash", OLD."model_provider", OLD."model_name", OLD."model_snapshot_hash",
    OLD."declared_budget_ceiling_e8_usd", OLD."created_by", OLD."trigger_type", OLD."created_at")
    OR NEW."case_manifest_snapshot"::text IS DISTINCT FROM OLD."case_manifest_snapshot"::text
    OR NEW."model_snapshot"::text IS DISTINCT FROM OLD."model_snapshot"::text
    OR NEW."run_config_snapshot"::text IS DISTINCT FROM OLD."run_config_snapshot"::text
    OR NEW."identity_snapshot"::text IS DISTINCT FROM OLD."identity_snapshot"::text
  THEN RAISE EXCEPTION 'evaluation run identity columns cannot change'; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
