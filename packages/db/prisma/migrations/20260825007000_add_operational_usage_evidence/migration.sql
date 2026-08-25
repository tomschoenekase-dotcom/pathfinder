BEGIN;

CREATE TYPE "OperationalUsageMetric" AS ENUM (
  'INTAKE_DECLARED_BYTES',
  'MEDIA_DECLARED_BYTES',
  'QUEUE_DEPTH',
  'QUEUE_FAILED_JOBS',
  'QUEUE_OLDEST_AGE_MILLISECONDS'
);

CREATE TYPE "OperationalUsageUnit" AS ENUM ('BYTES', 'JOBS', 'MILLISECONDS');
CREATE TYPE "OperationalUsageMeasurementKind" AS ENUM ('GAUGE', 'INTERVAL_TOTAL');

CREATE TABLE "operational_usage_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT,
  "venue_id" TEXT,
  "metric" "OperationalUsageMetric" NOT NULL,
  "measurement_kind" "OperationalUsageMeasurementKind" NOT NULL,
  "quantity" DECIMAL(20,6) NOT NULL,
  "unit" "OperationalUsageUnit" NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "period_start" TIMESTAMP(3),
  "period_end" TIMESTAMP(3),
  "source_system" VARCHAR(100) NOT NULL,
  "source_reference" VARCHAR(191) NOT NULL,
  "source_digest" CHAR(64) NOT NULL,
  "recorded_by_type" "ActorType" NOT NULL,
  "recorded_by_id" VARCHAR(191) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operational_usage_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_usage_evidence_scope_check"
    CHECK ("venue_id" IS NULL OR "tenant_id" IS NOT NULL),
  CONSTRAINT "operational_usage_evidence_quantity_check" CHECK ("quantity" >= 0),
  CONSTRAINT "operational_usage_evidence_source_digest_check"
    CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "operational_usage_evidence_text_check"
    CHECK (
      length(btrim("source_system")) > 0
      AND length(btrim("source_reference")) > 0
      AND length(btrim("recorded_by_id")) > 0
    ),
  CONSTRAINT "operational_usage_evidence_metric_unit_check"
    CHECK (
      ("metric" IN ('INTAKE_DECLARED_BYTES', 'MEDIA_DECLARED_BYTES') AND "unit" = 'BYTES')
      OR ("metric" IN ('QUEUE_DEPTH', 'QUEUE_FAILED_JOBS') AND "unit" = 'JOBS')
      OR ("metric" = 'QUEUE_OLDEST_AGE_MILLISECONDS' AND "unit" = 'MILLISECONDS')
    ),
  CONSTRAINT "operational_usage_evidence_measurement_kind_check"
    CHECK (
      "measurement_kind" = 'GAUGE'
      AND "period_start" IS NULL
      AND "period_end" IS NULL
    )
);

CREATE UNIQUE INDEX "operational_usage_evidence_operation_id_key"
  ON "operational_usage_evidence"("operation_id");
CREATE INDEX "operational_usage_evidence_scope_metric_idx"
  ON "operational_usage_evidence"("tenant_id", "venue_id", "metric", "observed_at");
CREATE INDEX "operational_usage_evidence_metric_time_idx"
  ON "operational_usage_evidence"("metric", "observed_at");
CREATE INDEX "operational_usage_evidence_recorded_at_idx"
  ON "operational_usage_evidence"("recorded_at");

ALTER TABLE "operational_usage_evidence"
  ADD CONSTRAINT "operational_usage_evidence_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operational_usage_evidence"
  ADD CONSTRAINT "operational_usage_evidence_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "operational_usage_evidence_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "operational_usage_evidence"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "operational_usage_evidence_append_only_truncate"
  BEFORE TRUNCATE ON "operational_usage_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

COMMIT;
