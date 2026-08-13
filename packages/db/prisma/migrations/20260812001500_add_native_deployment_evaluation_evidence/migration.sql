-- Additive, advisory-only native deployment evaluation evidence. No backfill is performed.
CREATE TYPE "EvalContentSnapshotKind" AS ENUM ('LEGACY_VENUE_CONTENT_V1', 'NATIVE_CORE_V1');
CREATE TYPE "NativeVenueDeploymentEvaluationDisposition" AS ENUM ('PASS', 'QUALITY_FAILURE', 'OPERATIONAL_FAILURE');

ALTER TABLE "eval_runs"
  ADD COLUMN "content_snapshot_kind" "EvalContentSnapshotKind" NOT NULL DEFAULT 'LEGACY_VENUE_CONTENT_V1',
  ADD COLUMN "content_snapshot_ref" VARCHAR(191);

ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_content_snapshot_shape_check" CHECK (
  ("content_snapshot_kind" = 'LEGACY_VENUE_CONTENT_V1' AND "content_snapshot_ref" IS NULL AND "content_snapshot_version" >= 0)
  OR
  ("content_snapshot_kind" = 'NATIVE_CORE_V1' AND "content_snapshot_ref" IS NOT NULL AND btrim("content_snapshot_ref") <> '' AND "content_snapshot_version" > 0)
);

CREATE UNIQUE INDEX "native_venue_releases_evaluation_scope_key"
  ON "native_venue_deployment_releases" ("id", "artifact_id", "manifest_hash", "desired_state_hash", "tenant_id", "venue_id");

CREATE TABLE "native_venue_deployment_evaluation_evidence" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "release_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "desired_state_hash" CHAR(64) NOT NULL,
  "run_id" UUID NOT NULL,
  "run_identity_hash" CHAR(64) NOT NULL,
  "run_completed_at" TIMESTAMP(3) NOT NULL,
  "disposition" "NativeVenueDeploymentEvaluationDisposition" NOT NULL,
  "manifest_case_count" INTEGER NOT NULL,
  "scored_case_count" INTEGER NOT NULL,
  "passed_case_count" INTEGER NOT NULL,
  "failed_case_count" INTEGER NOT NULL,
  "operational_failure_count" INTEGER NOT NULL,
  "total_latency_ms" INTEGER NOT NULL,
  "total_cost_e8_usd" BIGINT NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL DEFAULT 'HUMAN',
  "actor_role" VARCHAR(32) NOT NULL DEFAULT 'PLATFORM_ADMIN',
  "recorded_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_venue_deployment_evaluation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "native_deployment_evaluations_counts_check" CHECK (
    "manifest_case_count" BETWEEN 1 AND 50 AND
    "scored_case_count" BETWEEN 0 AND "manifest_case_count" AND
    "passed_case_count" BETWEEN 0 AND "scored_case_count" AND
    "failed_case_count" = "scored_case_count" - "passed_case_count" AND
    "operational_failure_count" = "manifest_case_count" - "scored_case_count" AND
    "total_latency_ms" >= 0 AND "total_cost_e8_usd" >= 0
  ),
  CONSTRAINT "native_deployment_evaluations_hashes_check" CHECK (
    "manifest_hash" ~ '^[0-9a-f]{64}$' AND "desired_state_hash" ~ '^[0-9a-f]{64}$' AND
    "run_identity_hash" ~ '^[0-9a-f]{64}$' AND "operation_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "native_deployment_evaluations_actor_check" CHECK ("actor_type" = 'HUMAN' AND "actor_role" = 'PLATFORM_ADMIN' AND btrim("recorded_by") <> '')
);

CREATE UNIQUE INDEX "native_deployment_evaluations_operation_key"
  ON "native_venue_deployment_evaluation_evidence" ("tenant_id", "operation_id");
CREATE UNIQUE INDEX "native_deployment_evaluations_release_run_key"
  ON "native_venue_deployment_evaluation_evidence" ("release_id", "run_id");
CREATE INDEX "native_deployment_evaluations_release_idx"
  ON "native_venue_deployment_evaluation_evidence" ("tenant_id", "venue_id", "release_id", "created_at");

ALTER TABLE "native_venue_deployment_evaluation_evidence"
  ADD CONSTRAINT "native_deployment_evaluations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "native_deployment_evaluations_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "native_deployment_evaluations_release_fkey" FOREIGN KEY ("release_id", "artifact_id", "manifest_hash", "desired_state_hash", "tenant_id", "venue_id") REFERENCES "native_venue_deployment_releases"("id", "artifact_id", "manifest_hash", "desired_state_hash", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "native_deployment_evaluations_run_fkey" FOREIGN KEY ("run_id", "run_identity_hash", "tenant_id", "venue_id") REFERENCES "eval_runs"("id", "identity_hash", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "validate_native_deployment_evaluation_evidence"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  rel record;
  eval record;
  expected record;
  expected_disposition public."NativeVenueDeploymentEvaluationDisposition";
  expected_snapshot_version integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.run_id::text, 1500));
  SELECT r.id, r.status, r.artifact_id, r.manifest_hash, r.desired_state_hash, r.plan
    INTO rel
    FROM public.native_venue_deployment_releases r
   WHERE r.id = NEW.release_id AND r.tenant_id = NEW.tenant_id AND r.venue_id = NEW.venue_id
   FOR SHARE;
  IF NOT FOUND OR rel.status NOT IN ('DRAFT', 'APPROVED') OR
     rel.artifact_id IS DISTINCT FROM NEW.artifact_id OR
     rel.manifest_hash IS DISTINCT FROM NEW.manifest_hash OR
     rel.desired_state_hash IS DISTINCT FROM NEW.desired_state_hash THEN
    RAISE EXCEPTION 'native deployment evaluation release mismatch';
  END IF;
  expected_snapshot_version := CASE
    WHEN rel.plan->'priorHead' = 'null'::jsonb THEN 1
    WHEN jsonb_typeof(rel.plan->'priorHead'->'revision') = 'number'
      THEN (rel.plan->'priorHead'->>'revision')::integer + 1
    ELSE NULL
  END;

  SELECT r.id, r.identity_hash, r.status, r.completed_at, r.content_snapshot_kind,
         r.content_snapshot_ref, r.content_snapshot_version, r.content_snapshot_hash,
         r.package_snapshot_ref, r.package_snapshot_hash, r.case_manifest_snapshot,
         r.identity_snapshot, r.run_config_snapshot, r.idempotency_key, r.corpus_hash,
         r.prompt_contract_version, r.prompt_contract_hash, r.model_provider, r.model_name,
         r.model_snapshot_hash, r.model_snapshot, r.declared_budget_ceiling_e8_usd,
         r.created_by, r.trigger_type
    INTO eval
    FROM public.eval_runs r
   WHERE r.id = NEW.run_id AND r.tenant_id = NEW.tenant_id AND r.venue_id = NEW.venue_id
   FOR SHARE;
  IF NOT FOUND OR eval.status IS DISTINCT FROM 'COMPLETED' OR eval.completed_at IS NULL OR
     eval.identity_hash IS DISTINCT FROM NEW.run_identity_hash OR
     eval.completed_at IS DISTINCT FROM NEW.run_completed_at OR
     eval.content_snapshot_kind IS DISTINCT FROM 'NATIVE_CORE_V1' OR
     eval.content_snapshot_ref IS DISTINCT FROM NEW.release_id::text OR
     eval.content_snapshot_version IS DISTINCT FROM expected_snapshot_version OR
     eval.content_snapshot_hash IS DISTINCT FROM NEW.desired_state_hash OR
     eval.package_snapshot_ref IS DISTINCT FROM ('native-core-v1:' || NEW.release_id::text) OR
     eval.package_snapshot_hash IS DISTINCT FROM NEW.manifest_hash OR
     eval.identity_snapshot->>'version' IS DISTINCT FROM 'pathfinder-eval-run-identity-v3' OR
     eval.identity_snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id OR
     eval.identity_snapshot->>'venueId' IS DISTINCT FROM NEW.venue_id OR
     eval.identity_snapshot->>'packageSnapshotRef' IS DISTINCT FROM ('native-core-v1:' || NEW.release_id::text) OR
     eval.identity_snapshot->>'packageSnapshotHash' IS DISTINCT FROM NEW.manifest_hash OR
     eval.identity_snapshot->>'contentSnapshotKind' IS DISTINCT FROM 'NATIVE_CORE_V1' OR
     eval.identity_snapshot->>'contentSnapshotRef' IS DISTINCT FROM NEW.release_id::text OR
     eval.identity_snapshot->>'contentSnapshotVersion' IS DISTINCT FROM eval.content_snapshot_version::text OR
     eval.identity_snapshot->>'contentSnapshotHash' IS DISTINCT FROM NEW.desired_state_hash OR
     eval.identity_snapshot->>'idempotencyKey' IS DISTINCT FROM eval.idempotency_key OR
     eval.identity_snapshot->>'corpusHash' IS DISTINCT FROM eval.corpus_hash OR
     eval.identity_snapshot->'caseManifest' IS DISTINCT FROM eval.case_manifest_snapshot OR
     eval.identity_snapshot->>'promptContractVersion' IS DISTINCT FROM eval.prompt_contract_version OR
     eval.identity_snapshot->>'promptContractHash' IS DISTINCT FROM eval.prompt_contract_hash OR
     eval.identity_snapshot->>'modelProvider' IS DISTINCT FROM eval.model_provider OR
     eval.identity_snapshot->>'modelName' IS DISTINCT FROM eval.model_name OR
     eval.identity_snapshot->>'modelSnapshotHash' IS DISTINCT FROM eval.model_snapshot_hash OR
     eval.identity_snapshot->'modelSnapshot' IS DISTINCT FROM eval.model_snapshot OR
     eval.identity_snapshot->'runConfigSnapshot' IS DISTINCT FROM eval.run_config_snapshot OR
     eval.identity_snapshot->>'declaredBudgetCeilingE8Usd' IS DISTINCT FROM eval.declared_budget_ceiling_e8_usd::text OR
     eval.identity_snapshot->>'createdBy' IS DISTINCT FROM eval.created_by OR
     eval.identity_snapshot->>'triggerType' IS DISTINCT FROM eval.trigger_type OR
     eval.run_config_snapshot->>'version' IS DISTINCT FROM 'pathfinder-native-evaluation-run-config-v1' OR
     eval.run_config_snapshot->'contentSnapshot'->>'tenantId' IS DISTINCT FROM NEW.tenant_id OR
     eval.run_config_snapshot->'contentSnapshot'->>'venueId' IS DISTINCT FROM NEW.venue_id OR
     eval.run_config_snapshot->'contentSnapshot'->>'releaseId' IS DISTINCT FROM NEW.release_id::text OR
     jsonb_typeof(eval.case_manifest_snapshot) IS DISTINCT FROM 'array' OR
     jsonb_array_length(eval.case_manifest_snapshot) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'native deployment evaluation run mismatch';
  END IF;

  IF NEW.operation_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'native-deployment-evaluation-evidence-v1' || pg_catalog.chr(10) || NEW.tenant_id || pg_catalog.chr(10) || NEW.venue_id || pg_catalog.chr(10) ||
    NEW.release_id::text || pg_catalog.chr(10) || NEW.run_id::text || pg_catalog.chr(10) || NEW.run_identity_hash || pg_catalog.chr(10) ||
    NEW.operation_id::text || pg_catalog.chr(10) || NEW.recorded_by, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'native deployment evaluation operation hash mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.eval_results er
     WHERE er.run_id = NEW.run_id AND er.tenant_id = NEW.tenant_id AND er.venue_id = NEW.venue_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(eval.case_manifest_snapshot) item
          WHERE item->>'caseId' = er.case_id::text
            AND (item->>'revision')::integer = er.case_revision
            AND item->>'caseHash' = er.case_hash
       )
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(eval.case_manifest_snapshot) item
     WHERE NOT EXISTS (
       SELECT 1 FROM public.eval_results er
        WHERE er.run_id = NEW.run_id AND er.tenant_id = NEW.tenant_id AND er.venue_id = NEW.venue_id
          AND er.case_id = (item->>'caseId')::uuid
          AND er.case_revision = (item->>'revision')::integer
          AND er.case_hash = item->>'caseHash'
     )
  ) OR EXISTS (
    SELECT 1 FROM public.eval_results er
     WHERE er.run_id = NEW.run_id AND er.tenant_id = NEW.tenant_id AND er.venue_id = NEW.venue_id
       AND ((er.outcome = 'SCORED' AND er.passed IS NULL)
         OR (er.outcome <> 'SCORED' AND er.passed IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'native deployment evaluation result evidence incomplete';
  END IF;

  SELECT jsonb_array_length(eval.case_manifest_snapshot)::integer AS manifest_count,
         count(*) FILTER (WHERE er.outcome = 'SCORED')::integer AS scored_count,
         count(*) FILTER (WHERE er.outcome = 'SCORED' AND er.passed IS TRUE)::integer AS passed_count,
         count(*) FILTER (WHERE er.outcome = 'SCORED' AND er.passed IS FALSE)::integer AS failed_count,
         count(*) FILTER (WHERE er.outcome <> 'SCORED')::integer AS operational_count,
         coalesce(sum(er.latency_ms), 0)::bigint AS latency_total,
         coalesce(sum(er.cost_e8_usd), 0)::bigint AS cost_total
    INTO expected
    FROM public.eval_results er
   WHERE er.run_id = NEW.run_id AND er.tenant_id = NEW.tenant_id AND er.venue_id = NEW.venue_id;

  IF expected.operational_count > 0 THEN expected_disposition := 'OPERATIONAL_FAILURE';
  ELSIF expected.failed_count > 0 THEN expected_disposition := 'QUALITY_FAILURE';
  ELSE expected_disposition := 'PASS'; END IF;

  IF expected.manifest_count IS DISTINCT FROM NEW.manifest_case_count OR
     expected.scored_count IS DISTINCT FROM NEW.scored_case_count OR
     expected.passed_count IS DISTINCT FROM NEW.passed_case_count OR
     expected.failed_count IS DISTINCT FROM NEW.failed_case_count OR
     expected.operational_count IS DISTINCT FROM NEW.operational_failure_count OR
     expected.latency_total > 2147483647 OR expected.latency_total::integer IS DISTINCT FROM NEW.total_latency_ms OR
     expected.cost_total IS DISTINCT FROM NEW.total_cost_e8_usd OR
     expected_disposition IS DISTINCT FROM NEW.disposition THEN
    RAISE EXCEPTION 'native deployment evaluation summary mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "native_deployment_evaluations_insert_guard"
BEFORE INSERT ON "native_venue_deployment_evaluation_evidence"
FOR EACH ROW EXECUTE FUNCTION "validate_native_deployment_evaluation_evidence"();

CREATE OR REPLACE FUNCTION "validate_native_deployment_evaluation_audit"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.tenant_id = NEW.tenant_id AND a.actor_id = NEW.recorded_by
       AND a.actor_role = 'PLATFORM_ADMIN'
       AND a.action = 'native_venue_deployment.evaluation-evidence-recorded'
       AND a.target_type = 'NativeVenueDeploymentEvaluationEvidence'
       AND a.target_id = NEW.id::text AND a.created_at = NEW.created_at
  ) THEN RAISE EXCEPTION 'native deployment evaluation audit mismatch'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "native_deployment_evaluations_audit_guard"
AFTER INSERT ON "native_venue_deployment_evaluation_evidence"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "validate_native_deployment_evaluation_audit"();

CREATE OR REPLACE FUNCTION "reject_native_deployment_evaluation_evidence_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'native deployment evaluation evidence is append-only';
END;
$$;

CREATE TRIGGER "native_deployment_evaluations_update_delete_guard"
BEFORE UPDATE OR DELETE ON "native_venue_deployment_evaluation_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_native_deployment_evaluation_evidence_mutation"();

CREATE TRIGGER "native_deployment_evaluations_truncate_guard"
BEFORE TRUNCATE ON "native_venue_deployment_evaluation_evidence"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_native_deployment_evaluation_evidence_mutation"();

CREATE OR REPLACE FUNCTION "reject_late_native_deployment_evaluation_result"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.run_id::text, 1500));
  IF EXISTS (
    SELECT 1 FROM public.native_venue_deployment_evaluation_evidence e
     WHERE e.run_id = NEW.run_id AND e.tenant_id = NEW.tenant_id AND e.venue_id = NEW.venue_id
  ) THEN
    RAISE EXCEPTION 'evaluation results are sealed by native deployment evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "eval_results_native_evidence_seal_guard"
BEFORE INSERT ON "eval_results"
FOR EACH ROW EXECUTE FUNCTION "reject_late_native_deployment_evaluation_result"();
