BEGIN;

CREATE TYPE "GuestAnswerAttributionEvaluationStatus" AS ENUM (
  'STAGED',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'AMBIGUOUS'
);

CREATE TABLE "guest_answer_attribution_evaluation_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "guest_chat_turn_id" UUID NOT NULL,
  "answer_hash" CHAR(64) NOT NULL,
  "evidence_set_hash" CHAR(64) NOT NULL,
  "status" "GuestAnswerAttributionEvaluationStatus" NOT NULL DEFAULT 'STAGED',
  "attempt_number" INTEGER NOT NULL DEFAULT 0,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "provider_dispatched_at" TIMESTAMP(3),
  "result_attribution_id" UUID,
  "last_error_code" VARCHAR(64),
  "created_by_id" VARCHAR(191) NOT NULL,
  "queued_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guest_answer_attribution_evaluation_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guest_answer_attribution_evaluations_attempt_check" CHECK ("attempt_number" >= 0),
  CONSTRAINT "guest_answer_attribution_evaluations_hash_check" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "answer_hash" ~ '^[0-9a-f]{64}$'
    AND "evidence_set_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "guest_answer_attribution_evaluations_lifecycle_check" CHECK (
    ("status" = 'STAGED' AND "queued_at" IS NULL AND "started_at" IS NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "provider_dispatched_at" IS NULL AND "result_attribution_id" IS NULL
      AND "completed_at" IS NULL AND "failed_at" IS NULL AND "last_error_code" IS NULL)
    OR
    ("status" = 'QUEUED' AND "queued_at" IS NOT NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "provider_dispatched_at" IS NULL AND "result_attribution_id" IS NULL
      AND "completed_at" IS NULL AND "failed_at" IS NULL AND "last_error_code" IS NULL)
    OR
    ("status" = 'RUNNING' AND "attempt_number" > 0 AND "queued_at" IS NOT NULL
      AND "started_at" IS NOT NULL AND "lease_token" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL AND "result_attribution_id" IS NULL
      AND "completed_at" IS NULL AND "failed_at" IS NULL AND "last_error_code" IS NULL)
    OR
    ("status" = 'COMPLETED' AND "attempt_number" > 0 AND "queued_at" IS NOT NULL
      AND "started_at" IS NOT NULL AND "provider_dispatched_at" IS NOT NULL
      AND "result_attribution_id" IS NOT NULL AND "completed_at" IS NOT NULL
      AND "lease_token" IS NULL AND "lease_expires_at" IS NULL
      AND "failed_at" IS NULL AND "last_error_code" IS NULL)
    OR
    ("status" IN ('FAILED', 'AMBIGUOUS') AND "attempt_number" > 0
      AND "queued_at" IS NOT NULL AND "started_at" IS NOT NULL
      AND "result_attribution_id" IS NULL AND "failed_at" IS NOT NULL
      AND "last_error_code" IS NOT NULL AND "lease_token" IS NULL
      AND "lease_expires_at" IS NULL AND "completed_at" IS NULL)
  )
);

ALTER TABLE "guest_answer_attribution_evaluation_requests"
  ADD CONSTRAINT "guest_answer_attribution_evaluations_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guest_answer_attribution_evaluation_requests"
  ADD CONSTRAINT "guest_answer_attribution_evaluations_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guest_answer_attribution_evaluation_requests"
  ADD CONSTRAINT "guest_answer_attribution_evaluations_session_fkey"
  FOREIGN KEY ("session_id", "tenant_id", "venue_id")
  REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guest_answer_attribution_evaluation_requests"
  ADD CONSTRAINT "guest_answer_attribution_evaluations_turn_fkey"
  FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id")
  REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guest_answer_attribution_evaluation_requests"
  ADD CONSTRAINT "guest_answer_attribution_evaluations_result_fkey"
  FOREIGN KEY ("result_attribution_id", "tenant_id", "venue_id")
  REFERENCES "guest_answer_attributions"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "guest_answer_attribution_evaluations_operation_key"
  ON "guest_answer_attribution_evaluation_requests"("tenant_id", "operation_id");

CREATE UNIQUE INDEX "guest_answer_attribution_evaluations_scope_key"
  ON "guest_answer_attribution_evaluation_requests"("id", "tenant_id", "venue_id");

CREATE UNIQUE INDEX "guest_answer_attribution_evaluations_result_key"
  ON "guest_answer_attribution_evaluation_requests"(
    "result_attribution_id", "tenant_id", "venue_id"
  );

CREATE INDEX "guest_answer_attribution_evaluations_scope_created_idx"
  ON "guest_answer_attribution_evaluation_requests"("tenant_id", "venue_id", "created_at");

CREATE INDEX "guest_answer_attribution_evaluations_recovery_idx"
  ON "guest_answer_attribution_evaluation_requests"("status", "lease_expires_at");

CREATE INDEX "guest_answer_attribution_evaluations_turn_created_idx"
  ON "guest_answer_attribution_evaluation_requests"(
    "tenant_id", "venue_id", "guest_chat_turn_id", "created_at"
  );

CREATE OR REPLACE FUNCTION guard_guest_answer_attribution_evaluation_request()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guest answer attribution evaluation requests cannot be deleted';
  END IF;

  IF NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."input_hash" IS DISTINCT FROM OLD."input_hash"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."guest_chat_turn_id" IS DISTINCT FROM OLD."guest_chat_turn_id"
    OR NEW."answer_hash" IS DISTINCT FROM OLD."answer_hash"
    OR NEW."evidence_set_hash" IS DISTINCT FROM OLD."evidence_set_hash"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'guest answer attribution evaluation request identity is immutable';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'FAILED', 'AMBIGUOUS') THEN
    RAISE EXCEPTION 'terminal guest answer attribution evaluation request is immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'STAGED' AND NEW."status" IN ('STAGED', 'QUEUED'))
    OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('QUEUED', 'RUNNING'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('RUNNING', 'QUEUED', 'COMPLETED', 'FAILED', 'AMBIGUOUS'))
  ) THEN
    RAISE EXCEPTION 'invalid guest answer attribution evaluation status transition';
  END IF;

  IF OLD."provider_dispatched_at" IS NOT NULL
    AND NEW."provider_dispatched_at" IS DISTINCT FROM OLD."provider_dispatched_at"
  THEN
    RAISE EXCEPTION 'provider dispatch evidence is immutable once recorded';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "guest_answer_attribution_evaluations_guard_update"
BEFORE UPDATE ON "guest_answer_attribution_evaluation_requests"
FOR EACH ROW EXECUTE FUNCTION guard_guest_answer_attribution_evaluation_request();

CREATE TRIGGER "guest_answer_attribution_evaluations_guard_delete"
BEFORE DELETE ON "guest_answer_attribution_evaluation_requests"
FOR EACH ROW EXECUTE FUNCTION guard_guest_answer_attribution_evaluation_request();

COMMIT;
