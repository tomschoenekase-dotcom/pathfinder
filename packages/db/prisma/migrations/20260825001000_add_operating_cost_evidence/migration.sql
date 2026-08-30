BEGIN;

CREATE TYPE "OperatingCostCategory" AS ENUM (
  'STORAGE',
  'EMAIL',
  'MEDIA_PROCESSING',
  'INFRASTRUCTURE',
  'OBSERVABILITY',
  'SECURITY',
  'BANDWIDTH',
  'OPERATOR_TIME',
  'OTHER'
);

CREATE TYPE "OperatingCostEvidenceKind" AS ENUM ('OBSERVED', 'ESTIMATED', 'ALLOCATED');

CREATE TABLE "operating_cost_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT,
  "venue_id" TEXT,
  "category" "OperatingCostCategory" NOT NULL,
  "evidence_kind" "OperatingCostEvidenceKind" NOT NULL,
  "amount_usd" DECIMAL(18,8) NOT NULL,
  "quantity" DECIMAL(20,6),
  "quantity_unit" VARCHAR(32),
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "source_system" VARCHAR(100) NOT NULL,
  "source_reference" VARCHAR(191) NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "supersedes_id" UUID,
  "recorded_by" VARCHAR(191) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operating_cost_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operating_cost_evidence_scope_check"
    CHECK ("venue_id" IS NULL OR "tenant_id" IS NOT NULL),
  CONSTRAINT "operating_cost_evidence_period_check"
    CHECK ("period_end" > "period_start"),
  CONSTRAINT "operating_cost_evidence_amount_check"
    CHECK ("amount_usd" >= 0),
  CONSTRAINT "operating_cost_evidence_quantity_check"
    CHECK (
      ("quantity" IS NULL AND "quantity_unit" IS NULL)
      OR ("quantity" >= 0 AND length(btrim("quantity_unit")) > 0)
    ),
  CONSTRAINT "operating_cost_evidence_text_check"
    CHECK (
      length(btrim("source_system")) > 0
      AND length(btrim("source_reference")) > 0
      AND length(btrim("description")) > 0
      AND length(btrim("recorded_by")) > 0
    )
);

CREATE UNIQUE INDEX "operating_cost_evidence_operation_id_key"
  ON "operating_cost_evidence"("operation_id");
CREATE UNIQUE INDEX "operating_cost_evidence_supersedes_id_key"
  ON "operating_cost_evidence"("supersedes_id");
CREATE UNIQUE INDEX "operating_cost_evidence_id_tenant_key"
  ON "operating_cost_evidence"("id", "tenant_id");
CREATE INDEX "operating_cost_evidence_scope_period_idx"
  ON "operating_cost_evidence"("tenant_id", "venue_id", "period_start", "period_end");
CREATE INDEX "operating_cost_evidence_category_period_idx"
  ON "operating_cost_evidence"("category", "period_start", "period_end");
CREATE INDEX "operating_cost_evidence_recorded_at_idx"
  ON "operating_cost_evidence"("recorded_at");

ALTER TABLE "operating_cost_evidence"
  ADD CONSTRAINT "operating_cost_evidence_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operating_cost_evidence"
  ADD CONSTRAINT "operating_cost_evidence_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operating_cost_evidence"
  ADD CONSTRAINT "operating_cost_evidence_supersedes_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "operating_cost_evidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "operating_cost_evidence_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "operating_cost_evidence"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "operating_cost_evidence_append_only_truncate"
  BEFORE TRUNCATE ON "operating_cost_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

COMMIT;
