BEGIN;

CREATE TYPE "EvalRunCostReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'AMBIGUOUS');

ALTER TABLE "eval_runs"
  ADD COLUMN "budget_accounted_e8_usd" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "eval_runs_budget_accounted_bounds_check"
    CHECK ("budget_accounted_e8_usd" >= 0 AND "budget_accounted_e8_usd" <= "declared_budget_ceiling_e8_usd");

CREATE TABLE "eval_run_cost_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "run_id" UUID NOT NULL,
  "run_identity_hash" CHAR(64) NOT NULL,
  "case_id" UUID NOT NULL,
  "case_revision" INTEGER NOT NULL,
  "case_hash" CHAR(64) NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" "EvalRunCostReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "reserved_cost_e8_usd" BIGINT NOT NULL,
  "settled_cost_e8_usd" BIGINT,
  "result_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),
  CONSTRAINT "eval_run_cost_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_run_cost_reservations_amount_check" CHECK (
    "attempt_number" >= 1 AND "reserved_cost_e8_usd" >= 0
    AND ("settled_cost_e8_usd" IS NULL OR ("settled_cost_e8_usd" >= 0 AND "settled_cost_e8_usd" <= "reserved_cost_e8_usd"))
  ),
  CONSTRAINT "eval_run_cost_reservations_terminal_check" CHECK (
    ("status" = 'RESERVED' AND "settled_cost_e8_usd" IS NULL AND "result_id" IS NULL AND "settled_at" IS NULL)
    OR ("status" = 'SETTLED' AND "settled_cost_e8_usd" IS NOT NULL AND "result_id" IS NOT NULL AND "settled_at" IS NOT NULL)
    OR ("status" = 'AMBIGUOUS' AND "settled_cost_e8_usd" IS NULL AND "result_id" IS NOT NULL AND "settled_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "eval_run_cost_reservations_scope_key"
  ON "eval_run_cost_reservations"("tenant_id", "venue_id", "run_id", "case_id", "case_revision");
CREATE UNIQUE INDEX "eval_run_cost_reservations_attempt_scope_key"
  ON "eval_run_cost_reservations"("tenant_id", "venue_id", "run_id", "case_id", "case_revision", "attempt_number");
CREATE UNIQUE INDEX "eval_run_cost_reservations_result_id_key" ON "eval_run_cost_reservations"("result_id");
CREATE UNIQUE INDEX "eval_run_cost_reservations_result_scope_key" ON "eval_run_cost_reservations"("result_id", "tenant_id", "venue_id");
CREATE INDEX "eval_run_cost_reservations_scope_status_idx"
  ON "eval_run_cost_reservations"("tenant_id", "venue_id", "run_id", "status");

ALTER TABLE "eval_run_cost_reservations"
  ADD CONSTRAINT "eval_run_cost_reservations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "eval_run_cost_reservations_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "eval_run_cost_reservations_run_fkey" FOREIGN KEY ("run_id", "run_identity_hash", "tenant_id", "venue_id") REFERENCES "eval_runs"("id", "identity_hash", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "eval_run_cost_reservations_case_fkey" FOREIGN KEY ("case_id", "case_revision", "case_hash", "tenant_id", "venue_id") REFERENCES "eval_cases"("id", "revision", "case_hash", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "eval_run_cost_reservations_result_fkey" FOREIGN KEY ("result_id", "tenant_id", "venue_id") REFERENCES "eval_results"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_eval_run_budget_accounting"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."budget_accounted_e8_usd" < OLD."budget_accounted_e8_usd" THEN
    RAISE EXCEPTION 'evaluation run budget accounting cannot decrease';
  END IF;
  IF OLD."status" IN ('LEGACY', 'COMPLETED', 'FAILED', 'CANCELLED')
     AND NEW."budget_accounted_e8_usd" IS DISTINCT FROM OLD."budget_accounted_e8_usd" THEN
    RAISE EXCEPTION 'terminal evaluation run budget accounting cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "eval_runs_budget_accounting_guard" BEFORE UPDATE ON "eval_runs"
FOR EACH ROW EXECUTE FUNCTION "guard_eval_run_budget_accounting"();

CREATE FUNCTION "guard_eval_run_cost_reservation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."tenant_id", NEW."venue_id", NEW."run_id", NEW."run_identity_hash",
    NEW."case_id", NEW."case_revision", NEW."case_hash", NEW."attempt_number",
    NEW."reserved_cost_e8_usd", NEW."created_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."tenant_id", OLD."venue_id", OLD."run_id", OLD."run_identity_hash",
    OLD."case_id", OLD."case_revision", OLD."case_hash", OLD."attempt_number",
    OLD."reserved_cost_e8_usd", OLD."created_at") THEN
    RAISE EXCEPTION 'evaluation cost reservation identity cannot change';
  END IF;
  IF OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('SETTLED', 'AMBIGUOUS') THEN
    RAISE EXCEPTION 'invalid evaluation cost reservation transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "eval_run_cost_reservations_update_guard" BEFORE UPDATE ON "eval_run_cost_reservations"
FOR EACH ROW EXECUTE FUNCTION "guard_eval_run_cost_reservation"();
CREATE TRIGGER "eval_run_cost_reservations_no_delete" BEFORE DELETE ON "eval_run_cost_reservations"
FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_run_cost_reservations_no_truncate" BEFORE TRUNCATE ON "eval_run_cost_reservations"
FOR EACH STATEMENT EXECUTE FUNCTION reject_eval_evidence_mutation();

COMMIT;
