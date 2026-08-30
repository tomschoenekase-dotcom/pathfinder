BEGIN;

CREATE TYPE "IntakeFileExtractionReviewDecision" AS ENUM ('ACCEPTED_FOR_PROPOSAL', 'REJECTED');
ALTER TYPE "IntakeEventKind" ADD VALUE 'FILE_EXTRACTION_REVIEW_RECORDED';

CREATE UNIQUE INDEX "intake_file_extraction_receipts_scope_run_key"
  ON "intake_file_extraction_receipts"("id", "tenant_id", "venue_id", "run_id");

CREATE TABLE "intake_file_extraction_reviews" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "source_run_id" TEXT NOT NULL,
  "receipt_id" UUID NOT NULL,
  "proposal_run_id" TEXT,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "decision" "IntakeFileExtractionReviewDecision" NOT NULL,
  "expected_extracted_text_hash" CHAR(64) NOT NULL,
  "proposal_title" VARCHAR(255),
  "proposal_notes" VARCHAR(20000),
  "proposal_notes_hash" CHAR(64),
  "rationale" VARCHAR(500) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_file_extraction_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_file_extraction_reviews_hashes_check" CHECK (
    "request_hash" ~ '^[a-f0-9]{64}$' AND
    "expected_extracted_text_hash" ~ '^[a-f0-9]{64}$' AND
    ("proposal_notes_hash" IS NULL OR "proposal_notes_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "intake_file_extraction_reviews_text_check" CHECK (
    char_length(btrim("rationale")) BETWEEN 1 AND 500 AND
    ("proposal_title" IS NULL OR char_length(btrim("proposal_title")) BETWEEN 1 AND 255) AND
    ("proposal_notes" IS NULL OR char_length(btrim("proposal_notes")) BETWEEN 1 AND 20000)
  ),
  CONSTRAINT "intake_file_extraction_reviews_decision_shape_check" CHECK (
    (
      "decision" = 'ACCEPTED_FOR_PROPOSAL' AND
      "proposal_run_id" IS NOT NULL AND
      "proposal_title" IS NOT NULL AND
      "proposal_notes" IS NOT NULL AND
      "proposal_notes_hash" IS NOT NULL
    ) OR (
      "decision" = 'REJECTED' AND
      "proposal_run_id" IS NULL AND
      "proposal_title" IS NULL AND
      "proposal_notes" IS NULL AND
      "proposal_notes_hash" IS NULL
    )
  ),
  CONSTRAINT "intake_file_extraction_reviews_distinct_runs_check" CHECK (
    "proposal_run_id" IS NULL OR "proposal_run_id" <> "source_run_id"
  )
);

CREATE UNIQUE INDEX "intake_file_extraction_reviews_request_key"
  ON "intake_file_extraction_reviews"("tenant_id", "request_id");
CREATE UNIQUE INDEX "intake_file_extraction_reviews_receipt_key"
  ON "intake_file_extraction_reviews"("receipt_id");
CREATE UNIQUE INDEX "intake_file_extraction_reviews_receipt_scope_run_key"
  ON "intake_file_extraction_reviews"("receipt_id", "tenant_id", "venue_id", "source_run_id");
CREATE UNIQUE INDEX "intake_file_extraction_reviews_proposal_key"
  ON "intake_file_extraction_reviews"("proposal_run_id");
CREATE UNIQUE INDEX "intake_file_extraction_reviews_proposal_scope_key"
  ON "intake_file_extraction_reviews"("proposal_run_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_file_extraction_reviews_scope_key"
  ON "intake_file_extraction_reviews"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_file_extraction_reviews_source_created_idx"
  ON "intake_file_extraction_reviews"("tenant_id", "venue_id", "source_run_id", "created_at");

ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_source_run_scope_fkey"
  FOREIGN KEY ("source_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_receipt_scope_fkey"
  FOREIGN KEY ("receipt_id", "tenant_id", "venue_id", "source_run_id") REFERENCES "intake_file_extraction_receipts"("id", "tenant_id", "venue_id", "run_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_proposal_run_scope_fkey"
  FOREIGN KEY ("proposal_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_intake_file_extraction_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER intake_file_extraction_reviews_append_only
  BEFORE UPDATE OR DELETE ON "intake_file_extraction_reviews"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_file_extraction_review_mutation();
CREATE TRIGGER intake_file_extraction_reviews_no_truncate
  BEFORE TRUNCATE ON "intake_file_extraction_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_file_extraction_review_mutation();

COMMIT;
