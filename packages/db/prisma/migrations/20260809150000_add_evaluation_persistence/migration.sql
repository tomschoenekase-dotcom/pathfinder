BEGIN;

CREATE TYPE "EvalResultOutcome" AS ENUM (
  'SCORED', 'OPERATIONAL_FAILURE', 'ADMISSION_DEFERRED', 'BUDGET_BLOCKED', 'CANCELLED'
);
CREATE TYPE "EvalReviewDecision" AS ENUM ('ACCEPTED', 'REJECTED', 'NEEDS_FOLLOW_UP');

CREATE TABLE "eval_cases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "case_key" VARCHAR(100) NOT NULL,
  "revision" INTEGER NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "category" VARCHAR(64) NOT NULL,
  "case_hash" CHAR(64) NOT NULL,
  "case_snapshot" JSONB NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_ref" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_cases_identity_check" CHECK (
    "revision" >= 1
    AND BTRIM("case_key") <> ''
    AND BTRIM("schema_version") <> ''
    AND BTRIM("category") <> ''
    AND BTRIM("created_by") <> ''
    AND BTRIM("source_type") <> ''
    AND BTRIM("source_ref") <> ''
    AND "case_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "eval_cases_snapshot_size_check" CHECK (
    OCTET_LENGTH("case_snapshot"::TEXT) <= 131072
  )
);

CREATE TABLE "eval_runs" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "identity_hash" CHAR(64) NOT NULL,
  "corpus_hash" CHAR(64) NOT NULL,
  "case_manifest_snapshot" JSONB NOT NULL,
  "prompt_contract_version" VARCHAR(64) NOT NULL,
  "prompt_contract_hash" CHAR(64) NOT NULL,
  "package_snapshot_ref" VARCHAR(191),
  "package_snapshot_hash" CHAR(64),
  "content_snapshot_version" BIGINT NOT NULL,
  "content_snapshot_hash" CHAR(64) NOT NULL,
  "model_provider" VARCHAR(64) NOT NULL,
  "model_name" VARCHAR(191) NOT NULL,
  "model_snapshot_hash" CHAR(64) NOT NULL,
  "model_snapshot" JSONB NOT NULL,
  "run_config_snapshot" JSONB NOT NULL,
  "identity_snapshot" JSONB NOT NULL,
  "declared_budget_ceiling_e8_usd" BIGINT NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "trigger_type" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_runs_identity_check" CHECK (
    BTRIM("idempotency_key") <> ''
    AND "identity_hash" ~ '^[0-9a-f]{64}$'
    AND "corpus_hash" ~ '^[0-9a-f]{64}$'
    AND BTRIM("prompt_contract_version") <> ''
    AND "prompt_contract_hash" ~ '^[0-9a-f]{64}$'
    AND (
      ("package_snapshot_ref" IS NULL AND "package_snapshot_hash" IS NULL)
      OR (
        "package_snapshot_ref" IS NOT NULL
        AND BTRIM("package_snapshot_ref") <> ''
        AND "package_snapshot_hash" ~ '^[0-9a-f]{64}$'
      )
    )
    AND "content_snapshot_version" >= 0
    AND "content_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND BTRIM("model_provider") <> ''
    AND BTRIM("model_name") <> ''
    AND BTRIM("created_by") <> ''
    AND BTRIM("trigger_type") <> ''
    AND "model_snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "declared_budget_ceiling_e8_usd" >= 0
  ),
  CONSTRAINT "eval_runs_snapshot_size_check" CHECK (
    OCTET_LENGTH("case_manifest_snapshot"::TEXT) <= 131072
    AND
    OCTET_LENGTH("model_snapshot"::TEXT) <= 65536
    AND OCTET_LENGTH("run_config_snapshot"::TEXT) <= 65536
    AND OCTET_LENGTH("identity_snapshot"::TEXT) <= 131072
  )
);

CREATE TABLE "eval_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "run_id" UUID NOT NULL,
  "run_identity_hash" CHAR(64) NOT NULL,
  "case_id" UUID NOT NULL,
  "case_revision" INTEGER NOT NULL,
  "case_hash" CHAR(64) NOT NULL,
  "outcome" "EvalResultOutcome" NOT NULL,
  "observation_hash" CHAR(64),
  "observation_snapshot" JSONB,
  "checks_snapshot" JSONB,
  "passed" BOOLEAN,
  "passed_checks" INTEGER,
  "total_checks" INTEGER,
  "error_code" VARCHAR(100),
  "latency_ms" INTEGER NOT NULL,
  "cost_e8_usd" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_results_identity_check" CHECK (
    "case_revision" >= 1
    AND "run_identity_hash" ~ '^[0-9a-f]{64}$'
    AND "case_hash" ~ '^[0-9a-f]{64}$'
    AND ("observation_hash" IS NULL OR "observation_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "eval_results_outcome_check" CHECK (
    (
      "outcome" = 'SCORED'
      AND "observation_hash" IS NOT NULL
      AND "observation_snapshot" IS NOT NULL
      AND "checks_snapshot" IS NOT NULL
      AND JSONB_TYPEOF("observation_snapshot") = 'object'
      AND JSONB_TYPEOF("checks_snapshot") = 'array'
      AND "passed" IS NOT NULL
      AND "passed_checks" IS NOT NULL
      AND "total_checks" IS NOT NULL
      AND "total_checks" > 0
      AND JSONB_ARRAY_LENGTH("checks_snapshot") = "total_checks"
      AND "passed_checks" >= 0
      AND "passed_checks" <= "total_checks"
      AND "passed" = ("passed_checks" = "total_checks")
      AND "error_code" IS NULL
    )
    OR
    (
      "outcome" <> 'SCORED'
      AND "observation_hash" IS NULL
      AND "observation_snapshot" IS NULL
      AND "checks_snapshot" IS NULL
      AND "passed" IS NULL
      AND "passed_checks" IS NULL
      AND "total_checks" IS NULL
      AND "error_code" IS NOT NULL
      AND BTRIM("error_code") <> ''
    )
  ),
  CONSTRAINT "eval_results_usage_check" CHECK ("latency_ms" >= 0 AND "cost_e8_usd" >= 0),
  CONSTRAINT "eval_results_snapshot_size_check" CHECK (
    ("observation_snapshot" IS NULL OR OCTET_LENGTH("observation_snapshot"::TEXT) <= 65536)
    AND ("checks_snapshot" IS NULL OR OCTET_LENGTH("checks_snapshot"::TEXT) <= 131072)
  )
);

CREATE TABLE "eval_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "result_id" UUID NOT NULL,
  "reviewer_id" VARCHAR(191) NOT NULL,
  "conclusion" VARCHAR(1000) NOT NULL,
  "decision" "EvalReviewDecision" NOT NULL,
  "rubric_version" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "eval_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "eval_reviews_content_check" CHECK (
    "revision" >= 1 AND BTRIM("reviewer_id") <> ''
    AND BTRIM("conclusion") <> '' AND BTRIM("rubric_version") <> ''
  )
);

COMMENT ON COLUMN "eval_runs"."declared_budget_ceiling_e8_usd" IS
  'Declared identity metadata only; not atomically enforced. One unit equals 10^-8 USD.';
COMMENT ON COLUMN "eval_results"."cost_e8_usd" IS
  'Observed or conservatively assigned cost. One unit equals 10^-8 USD.';

CREATE UNIQUE INDEX "eval_cases_tenant_id_venue_id_case_key_revision_key"
  ON "eval_cases"("tenant_id", "venue_id", "case_key", "revision");
CREATE UNIQUE INDEX "eval_cases_id_revision_case_hash_tenant_id_venue_id_key"
  ON "eval_cases"("id", "revision", "case_hash", "tenant_id", "venue_id");
CREATE INDEX "eval_cases_tenant_id_venue_id_category_created_at_idx"
  ON "eval_cases"("tenant_id", "venue_id", "category", "created_at");

CREATE UNIQUE INDEX "eval_runs_tenant_id_venue_id_idempotency_key_key"
  ON "eval_runs"("tenant_id", "venue_id", "idempotency_key");
CREATE UNIQUE INDEX "eval_runs_id_identity_hash_tenant_id_venue_id_key"
  ON "eval_runs"("id", "identity_hash", "tenant_id", "venue_id");
CREATE INDEX "eval_runs_tenant_id_venue_id_created_at_idx"
  ON "eval_runs"("tenant_id", "venue_id", "created_at");

CREATE UNIQUE INDEX "eval_results_run_id_case_id_case_revision_key"
  ON "eval_results"("run_id", "case_id", "case_revision");
CREATE INDEX "eval_results_tenant_id_venue_id_created_at_idx"
  ON "eval_results"("tenant_id", "venue_id", "created_at");
CREATE INDEX "eval_results_tenant_id_run_id_idx"
  ON "eval_results"("tenant_id", "run_id");
CREATE UNIQUE INDEX "eval_results_id_tenant_id_venue_id_key"
  ON "eval_results"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "eval_reviews_result_id_revision_key"
  ON "eval_reviews"("result_id", "revision");
CREATE INDEX "eval_reviews_tenant_id_venue_id_created_at_idx"
  ON "eval_reviews"("tenant_id", "venue_id", "created_at");

ALTER TABLE "eval_cases"
  ADD CONSTRAINT "eval_cases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_cases"
  ADD CONSTRAINT "eval_cases_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "eval_runs"
  ADD CONSTRAINT "eval_runs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_runs"
  ADD CONSTRAINT "eval_runs_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "eval_results"
  ADD CONSTRAINT "eval_results_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "eval_reviews"
  ADD CONSTRAINT "eval_reviews_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_reviews"
  ADD CONSTRAINT "eval_reviews_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_reviews"
  ADD CONSTRAINT "eval_reviews_result_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("result_id", "tenant_id", "venue_id")
  REFERENCES "eval_results"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_results"
  ADD CONSTRAINT "eval_results_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_results"
  ADD CONSTRAINT "eval_results_run_id_run_identity_hash_tenant_id_venue_id_fkey"
  FOREIGN KEY ("run_id", "run_identity_hash", "tenant_id", "venue_id")
  REFERENCES "eval_runs"("id", "identity_hash", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "eval_results"
  ADD CONSTRAINT "eval_results_case_id_case_revision_case_hash_tenant_id_ven_fkey"
  FOREIGN KEY ("case_id", "case_revision", "case_hash", "tenant_id", "venue_id")
  REFERENCES "eval_cases"("id", "revision", "case_hash", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_eval_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evaluation evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "eval_cases_immutable"
  BEFORE UPDATE OR DELETE ON "eval_cases"
  FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_runs_immutable"
  BEFORE UPDATE OR DELETE ON "eval_runs"
  FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_results_immutable"
  BEFORE UPDATE OR DELETE ON "eval_results"
  FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "eval_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_eval_evidence_mutation();

CREATE TRIGGER "eval_cases_no_truncate"
  BEFORE TRUNCATE ON "eval_cases"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_runs_no_truncate"
  BEFORE TRUNCATE ON "eval_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_results_no_truncate"
  BEFORE TRUNCATE ON "eval_results"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_eval_evidence_mutation();
CREATE TRIGGER "eval_reviews_no_truncate"
  BEFORE TRUNCATE ON "eval_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_eval_evidence_mutation();

COMMIT;
