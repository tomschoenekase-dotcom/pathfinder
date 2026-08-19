CREATE TYPE "AgentOutcomeSignalKind" AS ENUM (
  'HUMAN_REVIEW',
  'BUSINESS_OUTCOME',
  'QUALITY_EVALUATION',
  'CUSTOMER_SIGNAL',
  'SYSTEM_OBSERVATION'
);

CREATE TYPE "AgentOutcomeVerdict" AS ENUM (
  'POSITIVE',
  'MIXED',
  'NEGATIVE',
  'INCONCLUSIVE'
);

CREATE TABLE "agent_outcome_observations" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "signal_kind" "AgentOutcomeSignalKind" NOT NULL,
  "verdict" "AgentOutcomeVerdict" NOT NULL,
  "summary" VARCHAR(2000) NOT NULL,
  "evidence_ref" VARCHAR(500),
  "task_class" VARCHAR(100) NOT NULL,
  "model_provider" VARCHAR(100),
  "model_name" VARCHAR(191),
  "actor_type" "ActorType" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_outcome_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_outcome_observations_summary_check" CHECK (length(btrim("summary")) BETWEEN 1 AND 2000),
  CONSTRAINT "agent_outcome_observations_evidence_ref_check" CHECK ("evidence_ref" IS NULL OR length(btrim("evidence_ref")) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX "agent_outcome_observations_id_tenant_id_key"
  ON "agent_outcome_observations"("id", "tenant_id");
CREATE UNIQUE INDEX "agent_outcome_observations_tenant_operation_key"
  ON "agent_outcome_observations"("tenant_id", "operation_id");
CREATE INDEX "agent_outcome_observations_scope_created_idx"
  ON "agent_outcome_observations"("tenant_id", "venue_id", "created_at");
CREATE INDEX "agent_outcome_observations_identity_signal_idx"
  ON "agent_outcome_observations"("tenant_id", "agent_identity_id", "signal_kind", "created_at");
CREATE INDEX "agent_outcome_observations_run_created_idx"
  ON "agent_outcome_observations"("tenant_id", "agent_run_id", "created_at");
CREATE INDEX "agent_outcome_observations_created_idx"
  ON "agent_outcome_observations"("created_at");
CREATE INDEX "agent_runs_status_created_idx"
  ON "agent_runs"("status", "created_at");
CREATE INDEX "agent_questions_status_created_idx"
  ON "agent_questions"("status", "created_at");

ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_agent_run_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_agent_outcome_observation_insert() RETURNS trigger AS $$
DECLARE
  run_identity_id TEXT;
  run_type_value VARCHAR(100);
  run_provider VARCHAR(100);
  run_model VARCHAR(191);
  run_status "AgentRunStatus";
BEGIN
  SELECT "agent_identity_id", "run_type", "model_provider", "model_name", "status"
    INTO run_identity_id, run_type_value, run_provider, run_model, run_status
  FROM "agent_runs"
  WHERE "id" = NEW."agent_run_id"
    AND "tenant_id" = NEW."tenant_id"
    AND "venue_id" = NEW."venue_id";

  IF NOT FOUND OR run_identity_id IS DISTINCT FROM NEW."agent_identity_id" THEN
    RAISE EXCEPTION 'agent outcome does not match its run identity and scope' USING ERRCODE = '23514';
  END IF;
  IF run_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'agent outcome requires a terminal run' USING ERRCODE = '23514';
  END IF;
  IF NEW."task_class" IS DISTINCT FROM run_type_value
    OR NEW."model_provider" IS DISTINCT FROM run_provider
    OR NEW."model_name" IS DISTINCT FROM run_model
  THEN
    RAISE EXCEPTION 'agent outcome execution snapshot does not match its run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_outcome_observations_insert_guard"
  BEFORE INSERT ON "agent_outcome_observations"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_outcome_observation_insert();
CREATE TRIGGER "agent_outcome_observations_append_only"
  BEFORE UPDATE OR DELETE ON "agent_outcome_observations"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "agent_outcome_observations_no_truncate"
  BEFORE TRUNCATE ON "agent_outcome_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
