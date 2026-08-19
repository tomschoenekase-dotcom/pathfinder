CREATE TYPE "AgentQuestionStatus" AS ENUM ('PENDING', 'ANSWERED', 'DISMISSED');
ALTER TYPE "AgentRunStatus" ADD VALUE 'AWAITING_INPUT';
ALTER TABLE "agent_runs" ADD COLUMN "operation_id" UUID,
ADD COLUMN "request_prompt" VARCHAR(10000);
CREATE UNIQUE INDEX "agent_runs_tenant_operation_key" ON "agent_runs"("tenant_id", "operation_id");

CREATE OR REPLACE FUNCTION pathfinder_guard_agent_run_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_runs cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."agent_identity_id" IS DISTINCT FROM OLD."agent_identity_id"
    OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."run_type" IS DISTINCT FROM OLD."run_type"
    OR NEW."requested_operation" IS DISTINCT FROM OLD."requested_operation"
    OR NEW."request_prompt" IS DISTINCT FROM OLD."request_prompt"
    OR NEW."scope_snapshot" IS DISTINCT FROM OLD."scope_snapshot"
    OR NEW."initiated_by_type" IS DISTINCT FROM OLD."initiated_by_type"
    OR NEW."initiated_by_id" IS DISTINCT FROM OLD."initiated_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent run identity and scope are immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'AWAITING_INPUT', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('AWAITING_INPUT', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'AWAITING_INPUT' AND NEW."status" IN ('QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid agent run status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "agent_questions" (
    "id" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "agent_identity_id" TEXT NOT NULL,
    "agent_run_id" TEXT,
    "question" VARCHAR(2000) NOT NULL,
    "context" VARCHAR(2000),
    "choices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "status" "AgentQuestionStatus" NOT NULL DEFAULT 'PENDING',
    "answer" VARCHAR(5000),
    "answered_by_id" VARCHAR(191),
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_questions_answer_state_check" CHECK (
      ("status" = 'PENDING' AND "answer" IS NULL AND "answered_by_id" IS NULL AND "answered_at" IS NULL)
      OR ("status" IN ('ANSWERED', 'DISMISSED') AND "answer" IS NOT NULL AND "answered_by_id" IS NOT NULL AND "answered_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "agent_questions_id_tenant_id_key" ON "agent_questions"("id", "tenant_id");
CREATE UNIQUE INDEX "agent_questions_tenant_operation_key" ON "agent_questions"("tenant_id", "operation_id");
CREATE INDEX "agent_questions_scope_status_created_idx" ON "agent_questions"("tenant_id", "venue_id", "status", "created_at");
CREATE INDEX "agent_questions_identity_created_idx" ON "agent_questions"("tenant_id", "agent_identity_id", "created_at");
CREATE INDEX "agent_questions_run_created_idx" ON "agent_questions"("tenant_id", "agent_run_id", "created_at");

ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_agent_identity_id_tenant_id_fkey" FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_agent_run_id_tenant_id_venue_id_fkey" FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_agent_question_insert() RETURNS trigger AS $$
DECLARE
  identity_venue_id TEXT;
  identity_access_scope "AgentAccessScope";
  identity_enabled BOOLEAN;
  run_identity_id TEXT;
  run_status "AgentRunStatus";
BEGIN
  SELECT "venue_id", "access_scope", "enabled"
    INTO identity_venue_id, identity_access_scope, identity_enabled
  FROM "agent_identities"
  WHERE "id" = NEW."agent_identity_id" AND "tenant_id" = NEW."tenant_id";

  IF NOT FOUND OR NOT identity_enabled THEN
    RAISE EXCEPTION 'agent question identity is missing or disabled' USING ERRCODE = '23514';
  END IF;
  IF identity_access_scope = 'VENUE' AND NEW."venue_id" IS DISTINCT FROM identity_venue_id THEN
    RAISE EXCEPTION 'agent question venue exceeds its identity scope' USING ERRCODE = '23514';
  END IF;

  IF NEW."agent_run_id" IS NOT NULL THEN
    SELECT "agent_identity_id", "status" INTO run_identity_id, run_status
    FROM "agent_runs"
    WHERE "id" = NEW."agent_run_id"
      AND "tenant_id" = NEW."tenant_id"
      AND "venue_id" = NEW."venue_id";
    IF NOT FOUND OR run_identity_id IS DISTINCT FROM NEW."agent_identity_id" THEN
      RAISE EXCEPTION 'agent question does not match its run identity and scope' USING ERRCODE = '23514';
    END IF;
    IF run_status NOT IN ('QUEUED', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL') THEN
      RAISE EXCEPTION 'agent question run is not active' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_agent_question_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_questions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."agent_identity_id" IS DISTINCT FROM OLD."agent_identity_id"
    OR NEW."agent_run_id" IS DISTINCT FROM OLD."agent_run_id"
    OR NEW."question" IS DISTINCT FROM OLD."question"
    OR NEW."context" IS DISTINCT FROM OLD."context"
    OR NEW."choices" IS DISTINCT FROM OLD."choices"
    OR NEW."blocking" IS DISTINCT FROM OLD."blocking"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent question request is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (OLD."status" = 'PENDING' AND NEW."status" IN ('ANSWERED', 'DISMISSED'))
  THEN
    RAISE EXCEPTION 'invalid agent question status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_questions_insert_guard" BEFORE INSERT ON "agent_questions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_question_insert();
CREATE TRIGGER "agent_questions_revision_guard" BEFORE UPDATE OR DELETE ON "agent_questions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_question_revision();
CREATE TRIGGER "agent_questions_no_truncate" BEFORE TRUNCATE ON "agent_questions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
