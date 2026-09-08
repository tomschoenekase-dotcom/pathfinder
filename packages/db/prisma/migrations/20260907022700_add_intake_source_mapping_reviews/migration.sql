CREATE TYPE "IntakeSourceMappingReviewKind" AS ENUM ('WEBSITE_MAPPING', 'OPTIONAL_NOTES_SELECTION');

CREATE UNIQUE INDEX "intake_website_research_receipts_scope_run_key"
  ON "intake_website_research_receipts"("id", "tenant_id", "venue_id", "run_id");

CREATE TABLE "intake_source_mapping_reviews" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "source_run_id" TEXT NOT NULL,
  "proposal_run_id" TEXT NOT NULL,
  "kind" "IntakeSourceMappingReviewKind" NOT NULL,
  "source_input_hash" CHAR(64) NOT NULL,
  "research_receipt_id" UUID,
  "research_hash" CHAR(64),
  "request_hash" CHAR(64) NOT NULL,
  "mapping_version" INTEGER NOT NULL DEFAULT 1,
  "selection_snapshot" JSONB NOT NULL,
  "selection_hash" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "rationale" VARCHAR(500) NOT NULL,
  "reviewed_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_source_mapping_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_source_mapping_reviews_kind_fields_check" CHECK (
    ("kind" = 'WEBSITE_MAPPING' AND "research_receipt_id" IS NOT NULL AND "research_hash" IS NOT NULL)
    OR
    ("kind" = 'OPTIONAL_NOTES_SELECTION' AND "research_receipt_id" IS NULL AND "research_hash" IS NULL)
  ),
  CONSTRAINT "intake_source_mapping_reviews_hashes_check" CHECK (
    "source_input_hash" ~ '^[a-f0-9]{64}$' AND
    "request_hash" ~ '^[a-f0-9]{64}$' AND
    "selection_hash" ~ '^[a-f0-9]{64}$' AND
    "payload_hash" ~ '^[a-f0-9]{64}$' AND
    ("research_hash" IS NULL OR "research_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "intake_source_mapping_reviews_bounds_check" CHECK (
    "mapping_version" = 1 AND
    octet_length("selection_snapshot"::text) <= 50000 AND
    octet_length("payload"::text) <= 50000 AND
    length(btrim("rationale")) BETWEEN 1 AND 500 AND
    length(btrim("reviewed_by")) BETWEEN 1 AND 191
  )
);

CREATE UNIQUE INDEX "intake_source_mapping_reviews_proposal_key" ON "intake_source_mapping_reviews"("proposal_run_id");
CREATE UNIQUE INDEX "intake_source_mapping_reviews_scope_key" ON "intake_source_mapping_reviews"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_source_mapping_reviews_tenant_id_key" ON "intake_source_mapping_reviews"("tenant_id", "id");
CREATE UNIQUE INDEX "intake_source_mapping_reviews_proposal_scope_key" ON "intake_source_mapping_reviews"("proposal_run_id", "tenant_id", "venue_id");
CREATE INDEX "intake_source_mapping_reviews_source_created_idx" ON "intake_source_mapping_reviews"("tenant_id", "venue_id", "source_run_id", "created_at");

ALTER TABLE "intake_source_mapping_reviews" ADD CONSTRAINT "intake_source_mapping_reviews_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_source_mapping_reviews" ADD CONSTRAINT "intake_source_mapping_reviews_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_source_mapping_reviews" ADD CONSTRAINT "intake_source_mapping_reviews_source_run_fkey" FOREIGN KEY ("source_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_source_mapping_reviews" ADD CONSTRAINT "intake_source_mapping_reviews_proposal_run_fkey" FOREIGN KEY ("proposal_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_source_mapping_reviews" ADD CONSTRAINT "intake_source_mapping_reviews_research_receipt_fkey" FOREIGN KEY ("research_receipt_id", "tenant_id", "venue_id", "source_run_id") REFERENCES "intake_website_research_receipts"("id", "tenant_id", "venue_id", "run_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_intake_source_mapping_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'intake source mapping reviews are append-only';
END;
$$;

CREATE TRIGGER "intake_source_mapping_reviews_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "intake_source_mapping_reviews"
FOR EACH STATEMENT EXECUTE FUNCTION reject_intake_source_mapping_review_mutation();
