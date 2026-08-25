ALTER TABLE "agent_outcome_observations"
  ADD COLUMN "related_agent_action_id" TEXT,
  ADD COLUMN "policy_code" VARCHAR(191),
  ADD COLUMN "severity" "AgentOutcomeSeverity",
  ADD COLUMN "prediction_ref" VARCHAR(191),
  ADD COLUMN "predicted_confidence_bps" INTEGER,
  ADD COLUMN "actual_correct" BOOLEAN,
  ADD CONSTRAINT "agent_outcome_observations_structured_signal_check" CHECK (
    (
      "signal_kind" IN ('HUMAN_REVIEW', 'BUSINESS_OUTCOME', 'QUALITY_EVALUATION', 'CUSTOMER_SIGNAL', 'SYSTEM_OBSERVATION')
      AND "related_agent_action_id" IS NULL
      AND "policy_code" IS NULL
      AND "severity" IS NULL
      AND "prediction_ref" IS NULL
      AND "predicted_confidence_bps" IS NULL
      AND "actual_correct" IS NULL
    ) OR (
      "signal_kind" = 'ROLLBACK'
      AND "related_agent_action_id" IS NOT NULL
      AND "policy_code" IS NULL
      AND "severity" IS NULL
      AND "prediction_ref" IS NULL
      AND "predicted_confidence_bps" IS NULL
      AND "actual_correct" IS NULL
    ) OR (
      "signal_kind" = 'POLICY_VIOLATION'
      AND "policy_code" IS NOT NULL
      AND "severity" IS NOT NULL
      AND "prediction_ref" IS NULL
      AND "predicted_confidence_bps" IS NULL
      AND "actual_correct" IS NULL
    ) OR (
      "signal_kind" = 'CONFIDENCE_CALIBRATION'
      AND "related_agent_action_id" IS NULL
      AND "policy_code" IS NULL
      AND "severity" IS NULL
      AND "prediction_ref" IS NOT NULL
      AND "predicted_confidence_bps" BETWEEN 0 AND 10000
      AND "actual_correct" IS NOT NULL
    )
  );

ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_related_action_fkey"
  FOREIGN KEY ("related_agent_action_id", "tenant_id")
  REFERENCES "agent_actions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "agent_outcome_observations_signal_created_idx"
  ON "agent_outcome_observations"("tenant_id", "signal_kind", "created_at");
CREATE UNIQUE INDEX "agent_outcome_observations_rollback_action_key"
  ON "agent_outcome_observations"("tenant_id", "related_agent_action_id")
  WHERE "signal_kind" = 'ROLLBACK';
CREATE UNIQUE INDEX "agent_outcome_observations_prediction_key"
  ON "agent_outcome_observations"("tenant_id", "agent_run_id", "prediction_ref")
  WHERE "signal_kind" = 'CONFIDENCE_CALIBRATION';

CREATE OR REPLACE FUNCTION pathfinder_guard_agent_outcome_observation_insert() RETURNS trigger AS $$
DECLARE
  run_identity_id TEXT;
  run_type_value VARCHAR(100);
  run_provider VARCHAR(100);
  run_model VARCHAR(191);
  run_status "AgentRunStatus";
  action_run_id TEXT;
  action_identity_id TEXT;
  action_venue_id TEXT;
  action_status "AgentActionStatus";
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

  IF NEW."related_agent_action_id" IS NOT NULL THEN
    SELECT "agent_run_id", "agent_identity_id", "venue_id", "status"
      INTO action_run_id, action_identity_id, action_venue_id, action_status
    FROM "agent_actions"
    WHERE "id" = NEW."related_agent_action_id"
      AND "tenant_id" = NEW."tenant_id";

    IF NOT FOUND
      OR action_run_id IS DISTINCT FROM NEW."agent_run_id"
      OR action_identity_id IS DISTINCT FROM NEW."agent_identity_id"
      OR action_venue_id IS DISTINCT FROM NEW."venue_id"
      OR (NEW."signal_kind" = 'ROLLBACK' AND action_status IS DISTINCT FROM 'SUCCEEDED')
    THEN
      RAISE EXCEPTION 'agent outcome action does not match its run identity and scope' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
