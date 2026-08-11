BEGIN;

CREATE TYPE "ActorType" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');
CREATE TYPE "AgentAccessScope" AS ENUM ('VENUE', 'CLIENT', 'PLATFORM');
CREATE TYPE "AgentAutonomyLevel" AS ENUM ('READ_ONLY', 'DRAFT', 'INTERNAL_REVERSIBLE', 'BROAD_AUTONOMOUS');
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AgentActionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED');
CREATE TYPE "ApprovalRiskCategory" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "ApprovalDecisionOutcome" AS ENUM ('APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "agent_identities" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "identity_key" VARCHAR(100) NOT NULL,
  "name" VARCHAR(191) NOT NULL,
  "description" TEXT,
  "agent_type" VARCHAR(100) NOT NULL,
  "access_scope" "AgentAccessScope" NOT NULL,
  "access_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "autonomy_level" "AgentAutonomyLevel" NOT NULL DEFAULT 'READ_ONLY',
  "autonomous_actions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "default_provider" VARCHAR(100),
  "default_model" VARCHAR(191),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_identities_scope_check" CHECK (
    ("access_scope" = 'VENUE' AND "venue_id" IS NOT NULL)
    OR ("access_scope" IN ('CLIENT', 'PLATFORM') AND "venue_id" IS NULL)
  ),
  CONSTRAINT "agent_identities_content_check" CHECK (
    BTRIM("identity_key") <> '' AND BTRIM("name") <> ''
    AND BTRIM("agent_type") <> '' AND BTRIM("created_by") <> ''
  )
);

CREATE UNIQUE INDEX "agent_identities_tenant_id_identity_key_key" ON "agent_identities"("tenant_id", "identity_key");
CREATE UNIQUE INDEX "agent_identities_id_tenant_id_key" ON "agent_identities"("id", "tenant_id");
CREATE INDEX "agent_identities_tenant_id_enabled_idx" ON "agent_identities"("tenant_id", "enabled");
CREATE INDEX "agent_identities_tenant_id_venue_id_idx" ON "agent_identities"("tenant_id", "venue_id");

CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "agent_identity_id" TEXT NOT NULL,
  "run_type" VARCHAR(100) NOT NULL,
  "requested_operation" VARCHAR(191) NOT NULL,
  "scope_snapshot" JSONB NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
  "model_provider" VARCHAR(100),
  "model_name" VARCHAR(191),
  "cost_e8_usd" BIGINT NOT NULL DEFAULT 0,
  "artifacts" JSONB NOT NULL DEFAULT '[]',
  "error_code" VARCHAR(100),
  "error_message" TEXT,
  "initiated_by_type" "ActorType" NOT NULL,
  "initiated_by_id" VARCHAR(191) NOT NULL,
  "cancel_requested_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_runs_content_check" CHECK (
    BTRIM("run_type") <> '' AND BTRIM("requested_operation") <> ''
    AND BTRIM("initiated_by_id") <> '' AND "cost_e8_usd" >= 0
    AND JSONB_TYPEOF("scope_snapshot") = 'object'
    AND JSONB_TYPEOF("artifacts") = 'array'
  ),
  CONSTRAINT "agent_runs_lifecycle_check" CHECK (
    ("status" = 'QUEUED' AND "started_at" IS NULL AND "completed_at" IS NULL)
    OR ("status" IN ('RUNNING', 'AWAITING_APPROVAL') AND "started_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "agent_runs_error_check" CHECK (
    ("status" = 'FAILED' AND "error_code" IS NOT NULL AND BTRIM("error_code") <> '')
    OR ("status" <> 'FAILED' AND "error_code" IS NULL AND "error_message" IS NULL)
  )
);

CREATE UNIQUE INDEX "agent_runs_id_tenant_id_key" ON "agent_runs"("id", "tenant_id");
CREATE INDEX "agent_runs_tenant_id_status_created_at_idx" ON "agent_runs"("tenant_id", "status", "created_at");
CREATE INDEX "agent_runs_tenant_id_venue_id_created_at_idx" ON "agent_runs"("tenant_id", "venue_id", "created_at");
CREATE INDEX "agent_runs_tenant_id_agent_identity_id_created_at_idx" ON "agent_runs"("tenant_id", "agent_identity_id", "created_at");

CREATE TABLE "approval_requests" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "agent_identity_id" TEXT NOT NULL,
  "agent_run_id" TEXT,
  "requested_by_type" "ActorType" NOT NULL,
  "requested_by_id" VARCHAR(191) NOT NULL,
  "proposed_action" VARCHAR(191) NOT NULL,
  "scope_snapshot" JSONB NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "risk_category" "ApprovalRiskCategory" NOT NULL,
  "artifacts" JSONB NOT NULL DEFAULT '[]',
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_requests_content_check" CHECK (
    BTRIM("requested_by_id") <> '' AND BTRIM("proposed_action") <> '' AND BTRIM("reason") <> ''
    AND JSONB_TYPEOF("scope_snapshot") = 'object' AND JSONB_TYPEOF("artifacts") = 'array'
    AND ("expires_at" IS NULL OR "expires_at" > "created_at")
  )
);

CREATE UNIQUE INDEX "approval_requests_id_tenant_id_key" ON "approval_requests"("id", "tenant_id");
CREATE INDEX "approval_requests_tenant_id_created_at_idx" ON "approval_requests"("tenant_id", "created_at");
CREATE INDEX "approval_requests_tenant_id_venue_id_created_at_idx" ON "approval_requests"("tenant_id", "venue_id", "created_at");
CREATE INDEX "approval_requests_tenant_id_agent_identity_id_created_at_idx" ON "approval_requests"("tenant_id", "agent_identity_id", "created_at");

CREATE TABLE "approval_decisions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "approval_request_id" TEXT NOT NULL,
  "decision" "ApprovalDecisionOutcome" NOT NULL,
  "decided_by_type" "ActorType" NOT NULL,
  "decided_by_id" VARCHAR(191) NOT NULL,
  "reason" VARCHAR(2000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_decisions_content_check" CHECK (
    BTRIM("decided_by_id") <> ''
    AND "decided_by_type" <> 'AGENT'
    AND ("decision" <> 'APPROVED' OR "decided_by_type" = 'HUMAN')
    AND ("decision" = 'APPROVED' OR ("reason" IS NOT NULL AND BTRIM("reason") <> ''))
  )
);

CREATE UNIQUE INDEX "approval_decisions_id_tenant_id_key" ON "approval_decisions"("id", "tenant_id");
CREATE UNIQUE INDEX "approval_decisions_approval_request_id_tenant_id_key" ON "approval_decisions"("approval_request_id", "tenant_id");
CREATE INDEX "approval_decisions_tenant_id_created_at_idx" ON "approval_decisions"("tenant_id", "created_at");
CREATE INDEX "approval_decisions_tenant_id_venue_id_created_at_idx" ON "approval_decisions"("tenant_id", "venue_id", "created_at");

CREATE TABLE "agent_actions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "agent_run_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "approval_decision_id" TEXT,
  "actor_type" "ActorType" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "requested_operation" VARCHAR(191) NOT NULL,
  "action_name" VARCHAR(191) NOT NULL,
  "input_summary" VARCHAR(1000),
  "input_reference" VARCHAR(500),
  "output" JSONB,
  "model_provider" VARCHAR(100),
  "model_name" VARCHAR(191),
  "cost_e8_usd" BIGINT NOT NULL DEFAULT 0,
  "status" "AgentActionStatus" NOT NULL,
  "error_code" VARCHAR(100),
  "error_message" TEXT,
  "before_version_ref" VARCHAR(500),
  "after_version_ref" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_actions_content_check" CHECK (
    BTRIM("actor_id") <> '' AND BTRIM("requested_operation") <> '' AND BTRIM("action_name") <> ''
    AND "actor_type" = 'AGENT'
    AND "cost_e8_usd" >= 0
    AND (("status" = 'FAILED' AND "error_code" IS NOT NULL AND BTRIM("error_code") <> '')
      OR ("status" <> 'FAILED' AND "error_code" IS NULL AND "error_message" IS NULL))
  )
);

CREATE UNIQUE INDEX "agent_actions_id_tenant_id_key" ON "agent_actions"("id", "tenant_id");
CREATE UNIQUE INDEX "agent_actions_approval_decision_id_tenant_id_key" ON "agent_actions"("approval_decision_id", "tenant_id");
CREATE INDEX "agent_actions_tenant_id_agent_run_id_created_at_idx" ON "agent_actions"("tenant_id", "agent_run_id", "created_at");
CREATE INDEX "agent_actions_tenant_id_venue_id_created_at_idx" ON "agent_actions"("tenant_id", "venue_id", "created_at");
CREATE INDEX "agent_actions_tenant_id_action_name_created_at_idx" ON "agent_actions"("tenant_id", "action_name", "created_at");

CREATE TABLE "agent_timeline_events" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "agent_run_id" TEXT NOT NULL,
  "agent_action_id" TEXT,
  "actor_type" "ActorType" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "message" VARCHAR(1000),
  "data" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_timeline_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_timeline_events_content_check" CHECK (
    BTRIM("actor_id") <> '' AND BTRIM("event_type") <> '' AND JSONB_TYPEOF("data") = 'object'
  )
);

CREATE INDEX "agent_timeline_events_tenant_id_agent_run_id_created_at_idx" ON "agent_timeline_events"("tenant_id", "agent_run_id", "created_at");
CREATE INDEX "agent_timeline_events_tenant_id_venue_id_created_at_idx" ON "agent_timeline_events"("tenant_id", "venue_id", "created_at");

ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_run_id_tenant_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id") REFERENCES "agent_runs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approval_request_id_tenant_id_fkey"
  FOREIGN KEY ("approval_request_id", "tenant_id") REFERENCES "approval_requests"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agent_run_id_tenant_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id") REFERENCES "agent_runs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_approval_decision_id_tenant_id_fkey"
  FOREIGN KEY ("approval_decision_id", "tenant_id") REFERENCES "approval_decisions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_timeline_events" ADD CONSTRAINT "agent_timeline_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_timeline_events" ADD CONSTRAINT "agent_timeline_events_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_timeline_events" ADD CONSTRAINT "agent_timeline_events_agent_run_id_tenant_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id") REFERENCES "agent_runs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_timeline_events" ADD CONSTRAINT "agent_timeline_events_agent_action_id_tenant_id_fkey"
  FOREIGN KEY ("agent_action_id", "tenant_id") REFERENCES "agent_actions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_agent_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_agent_run_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_runs cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."agent_identity_id" IS DISTINCT FROM OLD."agent_identity_id"
    OR NEW."run_type" IS DISTINCT FROM OLD."run_type"
    OR NEW."requested_operation" IS DISTINCT FROM OLD."requested_operation"
    OR NEW."scope_snapshot" IS DISTINCT FROM OLD."scope_snapshot"
    OR NEW."initiated_by_type" IS DISTINCT FROM OLD."initiated_by_type"
    OR NEW."initiated_by_id" IS DISTINCT FROM OLD."initiated_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent run identity and scope are immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid agent run status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_approval_decision_insert() RETURNS trigger AS $$
DECLARE
  request_venue_id TEXT;
  request_expires_at TIMESTAMP(3);
BEGIN
  SELECT "venue_id", "expires_at" INTO request_venue_id, request_expires_at
  FROM "approval_requests"
  WHERE "id" = NEW."approval_request_id" AND "tenant_id" = NEW."tenant_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval request is missing from the decision tenant' USING ERRCODE = '23503';
  END IF;
  IF NEW."venue_id" IS DISTINCT FROM request_venue_id THEN
    RAISE EXCEPTION 'approval decision scope does not match its request' USING ERRCODE = '23514';
  END IF;
  IF NEW."decision" = 'APPROVED' AND request_expires_at IS NOT NULL AND request_expires_at <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'expired approval request cannot be approved' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_agent_run_insert() RETURNS trigger AS $$
DECLARE
  identity_venue_id TEXT;
  identity_access_scope "AgentAccessScope";
BEGIN
  SELECT "venue_id", "access_scope" INTO identity_venue_id, identity_access_scope
  FROM "agent_identities"
  WHERE "id" = NEW."agent_identity_id" AND "tenant_id" = NEW."tenant_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent identity is missing from the run tenant' USING ERRCODE = '23503';
  END IF;
  IF identity_access_scope = 'VENUE' AND NEW."venue_id" IS DISTINCT FROM identity_venue_id THEN
    RAISE EXCEPTION 'agent run venue exceeds its identity scope' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_approval_request_insert() RETURNS trigger AS $$
DECLARE
  identity_venue_id TEXT;
  identity_access_scope "AgentAccessScope";
  run_venue_id TEXT;
  run_identity_id TEXT;
BEGIN
  SELECT "venue_id", "access_scope" INTO identity_venue_id, identity_access_scope
  FROM "agent_identities"
  WHERE "id" = NEW."agent_identity_id" AND "tenant_id" = NEW."tenant_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent identity is missing from the approval tenant' USING ERRCODE = '23503';
  END IF;
  IF identity_access_scope = 'VENUE' AND NEW."venue_id" IS DISTINCT FROM identity_venue_id THEN
    RAISE EXCEPTION 'approval request venue exceeds its identity scope' USING ERRCODE = '23514';
  END IF;

  IF NEW."agent_run_id" IS NOT NULL THEN
    SELECT "venue_id", "agent_identity_id" INTO run_venue_id, run_identity_id
    FROM "agent_runs"
    WHERE "id" = NEW."agent_run_id" AND "tenant_id" = NEW."tenant_id";

    IF NOT FOUND OR run_identity_id IS DISTINCT FROM NEW."agent_identity_id" THEN
      RAISE EXCEPTION 'approval request does not match its agent run identity' USING ERRCODE = '23514';
    END IF;
    IF run_venue_id IS NOT NULL AND NEW."venue_id" IS DISTINCT FROM run_venue_id THEN
      RAISE EXCEPTION 'approval request does not match its agent run venue' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_approved_action_insert() RETURNS trigger AS $$
DECLARE
  run_venue_id TEXT;
  run_identity_id TEXT;
  identity_venue_id TEXT;
  identity_access_scope "AgentAccessScope";
  recorded_decision "ApprovalDecisionOutcome";
  request_venue_id TEXT;
  request_action VARCHAR(191);
BEGIN
  SELECT run."venue_id", run."agent_identity_id", identity."venue_id", identity."access_scope"
  INTO run_venue_id, run_identity_id, identity_venue_id, identity_access_scope
  FROM "agent_runs" run
  JOIN "agent_identities" identity
    ON identity."id" = run."agent_identity_id" AND identity."tenant_id" = run."tenant_id"
  WHERE run."id" = NEW."agent_run_id" AND run."tenant_id" = NEW."tenant_id";

  IF NOT FOUND OR run_identity_id IS DISTINCT FROM NEW."agent_identity_id" THEN
    RAISE EXCEPTION 'agent action does not match its run identity' USING ERRCODE = '23514';
  END IF;
  IF run_venue_id IS NOT NULL AND NEW."venue_id" IS DISTINCT FROM run_venue_id THEN
    RAISE EXCEPTION 'agent action does not match its run venue' USING ERRCODE = '23514';
  END IF;
  IF identity_access_scope = 'VENUE' AND NEW."venue_id" IS DISTINCT FROM identity_venue_id THEN
    RAISE EXCEPTION 'agent action venue exceeds its identity scope' USING ERRCODE = '23514';
  END IF;

  IF NEW."approval_decision_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT decision."decision", request."venue_id", request."proposed_action"
  INTO recorded_decision, request_venue_id, request_action
  FROM "approval_decisions" decision
  JOIN "approval_requests" request
    ON request."id" = decision."approval_request_id" AND request."tenant_id" = decision."tenant_id"
  WHERE decision."id" = NEW."approval_decision_id" AND decision."tenant_id" = NEW."tenant_id";

  IF NOT FOUND OR recorded_decision <> 'APPROVED' THEN
    RAISE EXCEPTION 'agent action requires an approved decision in the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW."venue_id" IS DISTINCT FROM request_venue_id OR NEW."action_name" IS DISTINCT FROM request_action THEN
    RAISE EXCEPTION 'agent action does not match its approved scope and operation' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_agent_timeline_insert() RETURNS trigger AS $$
DECLARE
  run_venue_id TEXT;
  action_venue_id TEXT;
  action_run_id TEXT;
BEGIN
  SELECT "venue_id" INTO run_venue_id
  FROM "agent_runs"
  WHERE "id" = NEW."agent_run_id" AND "tenant_id" = NEW."tenant_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'timeline event run is missing from its tenant' USING ERRCODE = '23503';
  END IF;
  IF run_venue_id IS NOT NULL AND NEW."venue_id" IS DISTINCT FROM run_venue_id THEN
    RAISE EXCEPTION 'timeline event does not match its run venue' USING ERRCODE = '23514';
  END IF;

  IF NEW."agent_action_id" IS NOT NULL THEN
    SELECT "venue_id", "agent_run_id" INTO action_venue_id, action_run_id
    FROM "agent_actions"
    WHERE "id" = NEW."agent_action_id" AND "tenant_id" = NEW."tenant_id";

    IF NOT FOUND OR action_run_id IS DISTINCT FROM NEW."agent_run_id" THEN
      RAISE EXCEPTION 'timeline event does not match its action run' USING ERRCODE = '23514';
    END IF;
    IF NEW."venue_id" IS DISTINCT FROM action_venue_id THEN
      RAISE EXCEPTION 'timeline event does not match its action venue' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_runs_revision_guard" BEFORE UPDATE OR DELETE ON "agent_runs"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_run_revision();
CREATE TRIGGER "agent_runs_no_truncate" BEFORE TRUNCATE ON "agent_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "agent_runs_insert_guard" BEFORE INSERT ON "agent_runs"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_run_insert();
CREATE TRIGGER "approval_requests_insert_guard" BEFORE INSERT ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_approval_request_insert();
CREATE TRIGGER "approval_decisions_insert_guard" BEFORE INSERT ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_approval_decision_insert();
CREATE TRIGGER "agent_actions_approval_guard" BEFORE INSERT ON "agent_actions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_approved_action_insert();
CREATE TRIGGER "agent_timeline_events_scope_guard" BEFORE INSERT ON "agent_timeline_events"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_timeline_insert();

CREATE TRIGGER "agent_actions_immutable" BEFORE UPDATE OR DELETE ON "agent_actions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "agent_timeline_events_immutable" BEFORE UPDATE OR DELETE ON "agent_timeline_events"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "approval_requests_immutable" BEFORE UPDATE OR DELETE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "approval_decisions_immutable" BEFORE UPDATE OR DELETE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();

CREATE TRIGGER "agent_actions_no_truncate" BEFORE TRUNCATE ON "agent_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "agent_timeline_events_no_truncate" BEFORE TRUNCATE ON "agent_timeline_events"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "approval_requests_no_truncate" BEFORE TRUNCATE ON "approval_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();
CREATE TRIGGER "approval_decisions_no_truncate" BEFORE TRUNCATE ON "approval_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_agent_evidence_mutation();

COMMIT;
