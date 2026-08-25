CREATE TYPE "FounderDirectiveTaskStatus" AS ENUM (
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'MATERIALIZED'
);

CREATE TABLE "founder_directive_task_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "founder_operating_exchange_id" UUID NOT NULL,
  "source_snapshot_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "approval_request_id" TEXT NOT NULL,
  "proposed_prompt" VARCHAR(10000) NOT NULL,
  "rationale" VARCHAR(2000) NOT NULL,
  "constraints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "prospect_scope" JSONB,
  "status" "FounderDirectiveTaskStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
  "materialization_operation_id" UUID,
  "materialization_hash" CHAR(64),
  "agent_run_id" TEXT,
  "requested_by_id" VARCHAR(191) NOT NULL,
  "credential_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "founder_directive_task_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "founder_directive_task_requests_hash_format_check" CHECK (
    "operation_hash" ~ '^[0-9a-f]{64}$'
    AND "source_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND ("materialization_hash" IS NULL OR "materialization_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "founder_directive_task_requests_materialization_state_check" CHECK (
    (
      "status" = 'MATERIALIZED'
      AND "materialization_operation_id" IS NOT NULL
      AND "materialization_hash" IS NOT NULL
      AND "agent_run_id" IS NOT NULL
    ) OR (
      "status" <> 'MATERIALIZED'
      AND "materialization_operation_id" IS NULL
      AND "materialization_hash" IS NULL
      AND "agent_run_id" IS NULL
    )
  ),
  CONSTRAINT "founder_directive_task_requests_prompt_check" CHECK (
    length(btrim("proposed_prompt")) > 0
    AND length(btrim("rationale")) > 0
  )
);

CREATE UNIQUE INDEX "founder_directive_task_requests_operation_id_key"
  ON "founder_directive_task_requests"("operation_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_exchange_key"
  ON "founder_directive_task_requests"("founder_operating_exchange_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_approval_key"
  ON "founder_directive_task_requests"("approval_request_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_materialization_operation_key"
  ON "founder_directive_task_requests"("materialization_operation_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_agent_run_key"
  ON "founder_directive_task_requests"("agent_run_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_id_scope_key"
  ON "founder_directive_task_requests"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_approval_scope_key"
  ON "founder_directive_task_requests"("approval_request_id", "tenant_id");
CREATE UNIQUE INDEX "founder_directive_task_requests_run_scope_key"
  ON "founder_directive_task_requests"("agent_run_id", "tenant_id", "venue_id");
CREATE INDEX "founder_directive_task_requests_status_created_idx"
  ON "founder_directive_task_requests"("status", "created_at", "id");
CREATE INDEX "founder_directive_task_requests_scope_status_idx"
  ON "founder_directive_task_requests"("tenant_id", "venue_id", "status", "created_at", "id");
CREATE INDEX "founder_directive_task_requests_credential_created_idx"
  ON "founder_directive_task_requests"("credential_id", "created_at", "id");

ALTER TABLE "founder_directive_task_requests"
  ADD CONSTRAINT "founder_directive_task_requests_exchange_fkey"
  FOREIGN KEY ("founder_operating_exchange_id")
  REFERENCES "founder_operating_exchanges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_tenant_fkey"
  FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id")
  REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_identity_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id")
  REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_approval_fkey"
  FOREIGN KEY ("approval_request_id", "tenant_id")
  REFERENCES "approval_requests"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_run_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id")
  REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "founder_directive_task_requests_credential_fkey"
  FOREIGN KEY ("credential_id")
  REFERENCES "platform_worker_policy_credentials"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION pathfinder_guard_founder_directive_task_request()
RETURNS trigger AS $$
DECLARE
  exchange_intent "FounderOperatingIntent";
  exchange_disposition "FounderOperatingDisposition";
  exchange_hash CHAR(64);
  approval_tenant TEXT;
  approval_venue TEXT;
  approval_identity TEXT;
  approval_action VARCHAR(191);
  approval_has_decision BOOLEAN;
  run_tenant TEXT;
  run_venue TEXT;
  run_identity TEXT;
  run_prompt VARCHAR(10000);
  run_status "AgentRunStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      OLD."id", OLD."operation_id", OLD."operation_hash",
      OLD."founder_operating_exchange_id", OLD."source_snapshot_hash",
      OLD."tenant_id", OLD."venue_id", OLD."agent_identity_id",
      OLD."approval_request_id", OLD."proposed_prompt", OLD."rationale",
      OLD."constraints", OLD."prospect_scope", OLD."requested_by_id",
      OLD."credential_id", OLD."created_at"
    ) IS DISTINCT FROM ROW(
      NEW."id", NEW."operation_id", NEW."operation_hash",
      NEW."founder_operating_exchange_id", NEW."source_snapshot_hash",
      NEW."tenant_id", NEW."venue_id", NEW."agent_identity_id",
      NEW."approval_request_id", NEW."proposed_prompt", NEW."rationale",
      NEW."constraints", NEW."prospect_scope", NEW."requested_by_id",
      NEW."credential_id", NEW."created_at"
    ) THEN
      RAISE EXCEPTION 'founder directive task request immutable proposal fields cannot change'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'MATERIALIZED')
    ) THEN
      RAISE EXCEPTION 'invalid founder directive task status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT "intent", "disposition", "snapshot_hash"
    INTO exchange_intent, exchange_disposition, exchange_hash
  FROM "founder_operating_exchanges"
  WHERE "id" = NEW."founder_operating_exchange_id";
  IF NOT FOUND
    OR exchange_intent IS DISTINCT FROM 'DIRECTIVE'
    OR exchange_disposition IS DISTINCT FROM 'RECORDED_FOR_TRIAGE'
    OR exchange_hash IS DISTINCT FROM NEW."source_snapshot_hash"
  THEN
    RAISE EXCEPTION 'founder directive task source is not an exact retained directive'
      USING ERRCODE = '23514';
  END IF;

  SELECT ar."tenant_id", ar."venue_id", ar."agent_identity_id", ar."proposed_action",
         (ad."id" IS NOT NULL)
    INTO approval_tenant, approval_venue, approval_identity, approval_action, approval_has_decision
  FROM "approval_requests" ar
  LEFT JOIN "approval_decisions" ad ON ad."approval_request_id" = ar."id"
  WHERE ar."id" = NEW."approval_request_id";
  IF NOT FOUND
    OR approval_tenant IS DISTINCT FROM NEW."tenant_id"
    OR approval_venue IS DISTINCT FROM NEW."venue_id"
    OR approval_identity IS DISTINCT FROM NEW."agent_identity_id"
    OR approval_action IS DISTINCT FROM 'torchiko.founder-directive.materialize-task'
  THEN
    RAISE EXCEPTION 'founder directive task approval scope does not match its proposal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'AWAITING_APPROVAL' AND approval_has_decision THEN
    RAISE EXCEPTION 'awaiting founder directive task cannot already have a decision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'MATERIALIZED' THEN
    SELECT "tenant_id", "venue_id", "agent_identity_id", "request_prompt", "status"
      INTO run_tenant, run_venue, run_identity, run_prompt, run_status
    FROM "agent_runs"
    WHERE "id" = NEW."agent_run_id";
    IF NOT FOUND
      OR run_tenant IS DISTINCT FROM NEW."tenant_id"
      OR run_venue IS DISTINCT FROM NEW."venue_id"
      OR run_identity IS DISTINCT FROM NEW."agent_identity_id"
      OR run_prompt IS DISTINCT FROM NEW."proposed_prompt"
      OR run_status IS DISTINCT FROM 'QUEUED'
    THEN
      RAISE EXCEPTION 'materialized founder directive task does not match its exact queued run'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "founder_directive_task_requests_guard"
  BEFORE INSERT OR UPDATE ON "founder_directive_task_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_founder_directive_task_request();

CREATE TRIGGER "founder_directive_task_requests_no_delete"
  BEFORE DELETE ON "founder_directive_task_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

CREATE TRIGGER "founder_directive_task_requests_no_truncate"
  BEFORE TRUNCATE ON "founder_directive_task_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
