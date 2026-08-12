BEGIN;

-- Historical rows created under the earlier nullable-venue guards must already
-- satisfy the stronger exact chain. Abort rather than repairing or guessing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "approval_requests" request
    JOIN "agent_runs" run
      ON run."id" = request."agent_run_id"
     AND run."tenant_id" = request."tenant_id"
    WHERE request."agent_run_id" IS NOT NULL
      AND (
        request."venue_id" IS DISTINCT FROM run."venue_id"
        OR request."agent_identity_id" IS DISTINCT FROM run."agent_identity_id"
      )
  ) THEN
    RAISE EXCEPTION 'historical approval request does not exactly match its agent run';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_actions" action
    JOIN "agent_runs" run
      ON run."id" = action."agent_run_id"
     AND run."tenant_id" = action."tenant_id"
    WHERE action."venue_id" IS DISTINCT FROM run."venue_id"
       OR action."agent_identity_id" IS DISTINCT FROM run."agent_identity_id"
       OR action."requested_operation" IS DISTINCT FROM run."requested_operation"
  ) THEN
    RAISE EXCEPTION 'historical agent action does not exactly match its run';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_actions" action
    JOIN "approval_decisions" decision
      ON decision."id" = action."approval_decision_id"
     AND decision."tenant_id" = action."tenant_id"
    JOIN "approval_requests" request
      ON request."id" = decision."approval_request_id"
     AND request."tenant_id" = decision."tenant_id"
    WHERE action."approval_decision_id" IS NOT NULL
      AND (
        decision."decision" IS DISTINCT FROM 'APPROVED'::"ApprovalDecisionOutcome"
        OR request."agent_run_id" IS NULL
        OR request."agent_run_id" IS DISTINCT FROM action."agent_run_id"
        OR request."agent_identity_id" IS DISTINCT FROM action."agent_identity_id"
        OR request."venue_id" IS DISTINCT FROM action."venue_id"
        OR request."proposed_action" IS DISTINCT FROM action."action_name"
      )
  ) THEN
    RAISE EXCEPTION 'historical approved action lacks an exact approval chain';
  END IF;
END;
$$;

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_id_tenant_id_venue_id_key"
  UNIQUE ("id", "tenant_id", "venue_id");

CREATE TABLE "support_agent_run_lineages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "request_version" INTEGER NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "linked_run_status" "AgentRunStatus" NOT NULL,
  "linked_run_completed_at" TIMESTAMP(3) NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "linked_by_kind" "SupportParticipantKind" NOT NULL DEFAULT 'OPERATOR',
  "linked_by_id" VARCHAR(191) NOT NULL,
  "linked_by_role" VARCHAR(64) NOT NULL DEFAULT 'PLATFORM_ADMIN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_agent_run_lineages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_agent_run_lineages_request_version_check" CHECK ("request_version" > 0),
  CONSTRAINT "support_agent_run_lineages_terminal_status_check" CHECK ("linked_run_status" IN ('COMPLETED', 'FAILED', 'CANCELLED')),
  CONSTRAINT "support_agent_run_lineages_operation_hash_check" CHECK ("operation_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "support_agent_run_lineages_actor_check" CHECK (
    "linked_by_kind" = 'OPERATOR'
    AND "linked_by_role" = 'PLATFORM_ADMIN'
    AND char_length(btrim("linked_by_id")) > 0
  )
);

ALTER TABLE "support_agent_run_lineages" ADD CONSTRAINT "support_agent_run_lineages_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_agent_run_lineages" ADD CONSTRAINT "support_agent_run_lineages_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_agent_run_lineages" ADD CONSTRAINT "support_agent_run_lineages_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_agent_run_lineages" ADD CONSTRAINT "support_agent_run_lineages_request_event_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id", "request_version") REFERENCES "support_request_audit_events"("support_request_id", "tenant_id", "venue_id", "request_version") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_agent_run_lineages" ADD CONSTRAINT "support_agent_run_lineages_run_scope_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "support_agent_run_lineages_tenant_operation_key"
  ON "support_agent_run_lineages"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "support_agent_run_lineages_run_scope_key"
  ON "support_agent_run_lineages"("agent_run_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "support_agent_run_lineages_request_version_key"
  ON "support_agent_run_lineages"("support_request_id", "tenant_id", "venue_id", "request_version");
CREATE INDEX "support_agent_run_lineages_request_created_idx"
  ON "support_agent_run_lineages"("tenant_id", "venue_id", "support_request_id", "created_at", "id");

CREATE FUNCTION pathfinder_reject_support_agent_run_lineage_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support agent-run lineage is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_support_agent_run_lineage_insert() RETURNS trigger AS $$
DECLARE
  run_status "AgentRunStatus";
  run_completed_at TIMESTAMP(3);
BEGIN
  SELECT "status", "completed_at" INTO run_status, run_completed_at
  FROM "agent_runs"
  WHERE "id" = NEW."agent_run_id"
    AND "tenant_id" = NEW."tenant_id"
    AND "venue_id" = NEW."venue_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'support lineage agent run is missing from exact scope' USING ERRCODE = '23503';
  END IF;
  IF run_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    OR run_completed_at IS NULL
    OR NEW."linked_run_status" IS DISTINCT FROM run_status
    OR NEW."linked_run_completed_at" IS DISTINCT FROM run_completed_at
  THEN
    RAISE EXCEPTION 'support lineage requires exact terminal agent run evidence' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "support_agent_run_lineages_insert_guard"
  BEFORE INSERT ON "support_agent_run_lineages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_support_agent_run_lineage_insert();

CREATE TRIGGER "support_agent_run_lineages_append_only"
  BEFORE UPDATE OR DELETE ON "support_agent_run_lineages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_agent_run_lineage_mutation();
CREATE TRIGGER "support_agent_run_lineages_no_truncate"
  BEFORE TRUNCATE ON "support_agent_run_lineages"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_agent_run_lineage_mutation();

CREATE OR REPLACE FUNCTION pathfinder_guard_approval_request_insert() RETURNS trigger AS $$
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
    IF NEW."venue_id" IS DISTINCT FROM run_venue_id THEN
      RAISE EXCEPTION 'approval request does not match its agent run venue' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pathfinder_guard_approved_action_insert() RETURNS trigger AS $$
DECLARE
  run_venue_id TEXT;
  run_identity_id TEXT;
  run_requested_operation VARCHAR(191);
  identity_venue_id TEXT;
  identity_access_scope "AgentAccessScope";
  recorded_decision "ApprovalDecisionOutcome";
  request_venue_id TEXT;
  request_run_id TEXT;
  request_identity_id TEXT;
  request_action VARCHAR(191);
BEGIN
  SELECT run."venue_id", run."agent_identity_id", run."requested_operation",
         identity."venue_id", identity."access_scope"
  INTO run_venue_id, run_identity_id, run_requested_operation,
       identity_venue_id, identity_access_scope
  FROM "agent_runs" run
  JOIN "agent_identities" identity
    ON identity."id" = run."agent_identity_id" AND identity."tenant_id" = run."tenant_id"
  WHERE run."id" = NEW."agent_run_id" AND run."tenant_id" = NEW."tenant_id";

  IF NOT FOUND OR run_identity_id IS DISTINCT FROM NEW."agent_identity_id" THEN
    RAISE EXCEPTION 'agent action does not match its run identity' USING ERRCODE = '23514';
  END IF;
  IF NEW."venue_id" IS DISTINCT FROM run_venue_id THEN
    RAISE EXCEPTION 'agent action does not match its run venue' USING ERRCODE = '23514';
  END IF;
  IF NEW."requested_operation" IS DISTINCT FROM run_requested_operation THEN
    RAISE EXCEPTION 'agent action does not match its run requested operation' USING ERRCODE = '23514';
  END IF;
  IF identity_access_scope = 'VENUE' AND NEW."venue_id" IS DISTINCT FROM identity_venue_id THEN
    RAISE EXCEPTION 'agent action venue exceeds its identity scope' USING ERRCODE = '23514';
  END IF;

  IF NEW."approval_decision_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT decision."decision", request."venue_id", request."agent_run_id",
         request."agent_identity_id", request."proposed_action"
  INTO recorded_decision, request_venue_id, request_run_id, request_identity_id, request_action
  FROM "approval_decisions" decision
  JOIN "approval_requests" request
    ON request."id" = decision."approval_request_id" AND request."tenant_id" = decision."tenant_id"
  WHERE decision."id" = NEW."approval_decision_id" AND decision."tenant_id" = NEW."tenant_id";

  IF NOT FOUND OR recorded_decision <> 'APPROVED' THEN
    RAISE EXCEPTION 'agent action requires an approved decision in the same tenant' USING ERRCODE = '23514';
  END IF;
  IF request_run_id IS NULL
    OR request_run_id IS DISTINCT FROM NEW."agent_run_id"
    OR request_identity_id IS DISTINCT FROM NEW."agent_identity_id"
    OR request_venue_id IS DISTINCT FROM NEW."venue_id"
    OR request_action IS DISTINCT FROM NEW."action_name"
  THEN
    RAISE EXCEPTION 'agent action does not match its exact approved run, identity, venue, operation and outcome' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
