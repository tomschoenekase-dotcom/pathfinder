-- An expired agent-run lease is recoverable by a replacement bridge session.
-- Every other run identity/scope mutation and live-owner replacement remains rejected.
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
    (
      OLD."execution_bridge_session_id" IS NULL
      AND NEW."execution_bridge_session_id" IS NOT NULL
      AND NEW."status" = 'RUNNING'
    )
    OR (
      OLD."execution_bridge_session_id" IS NOT NULL
      AND NEW."execution_bridge_session_id" IS NOT NULL
      AND OLD."status" = 'RUNNING'
      AND NEW."status" = 'RUNNING'
      AND OLD."execution_lease_expires_at" < CURRENT_TIMESTAMP
      AND NEW."attempt_number" = OLD."attempt_number" + 1
      AND NEW."execution_lease_token" IS NOT NULL
      AND NEW."execution_lease_token" IS DISTINCT FROM OLD."execution_lease_token"
    )
  ) THEN
    RAISE EXCEPTION 'agent run bridge ownership can change only at initial claim or fenced expired-lease takeover' USING ERRCODE = '55000';
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
