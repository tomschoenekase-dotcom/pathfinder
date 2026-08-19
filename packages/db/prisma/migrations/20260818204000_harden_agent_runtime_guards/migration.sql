ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_lifecycle_check";
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_lifecycle_check" CHECK (
  ("status" IN ('QUEUED', 'AWAITING_INPUT') AND "completed_at" IS NULL)
  OR ("status" IN ('RUNNING', 'AWAITING_APPROVAL') AND "started_at" IS NOT NULL AND "completed_at" IS NULL)
  OR ("status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL)
);

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_attempt_bounds_check" CHECK (
  "attempt_number" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt_number" <= "max_attempts"
);

CREATE OR REPLACE FUNCTION pathfinder_guard_agent_run_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_runs cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."agent_identity_id" IS DISTINCT FROM OLD."agent_identity_id"
    OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."parent_agent_run_id" IS DISTINCT FROM OLD."parent_agent_run_id"
    OR NEW."delegation_reason" IS DISTINCT FROM OLD."delegation_reason"
    OR NEW."run_type" IS DISTINCT FROM OLD."run_type"
    OR NEW."requested_operation" IS DISTINCT FROM OLD."requested_operation"
    OR NEW."request_prompt" IS DISTINCT FROM OLD."request_prompt"
    OR NEW."scope_snapshot" IS DISTINCT FROM OLD."scope_snapshot"
    OR NEW."initiated_by_type" IS DISTINCT FROM OLD."initiated_by_type"
    OR NEW."initiated_by_id" IS DISTINCT FROM OLD."initiated_by_id"
    OR NEW."max_attempts" IS DISTINCT FROM OLD."max_attempts"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent run identity and scope are immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW."execution_bridge_session_id" IS DISTINCT FROM OLD."execution_bridge_session_id" AND NOT (
    OLD."execution_bridge_session_id" IS NULL
    AND NEW."execution_bridge_session_id" IS NOT NULL
    AND NEW."status" = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'agent run bridge ownership is immutable once claimed' USING ERRCODE = '55000';
  END IF;

  IF NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number" AND NOT (
    NEW."attempt_number" = OLD."attempt_number" + 1 AND NEW."status" = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'agent run attempts must advance exactly once at claim' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'AWAITING_INPUT', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('QUEUED', 'AWAITING_INPUT', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'AWAITING_INPUT' AND NEW."status" IN ('QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'))
    OR (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid agent run status transition from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_reject_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_messages_append_only" BEFORE UPDATE OR DELETE ON "agent_messages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "agent_messages_no_truncate" BEFORE TRUNCATE ON "agent_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

CREATE FUNCTION pathfinder_guard_agent_bridge_session_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_bridge_sessions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."scope_key" IS DISTINCT FROM OLD."scope_key"
    OR NEW."credential_id" IS DISTINCT FROM OLD."credential_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent bridge session identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
    RAISE EXCEPTION 'revoked agent bridge sessions cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_bridge_sessions_revision_guard"
  BEFORE UPDATE OR DELETE ON "agent_bridge_sessions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_bridge_session_revision();
CREATE TRIGGER "agent_bridge_sessions_no_truncate" BEFORE TRUNCATE ON "agent_bridge_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
