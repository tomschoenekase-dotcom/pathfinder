ALTER TABLE "prospect_import_source_records"
  ADD COLUMN "record_metadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "processing_status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "claim_owner" VARCHAR(191),
  ADD COLUMN "claim_expires_at" TIMESTAMP(3),
  ADD COLUMN "error_code" VARCHAR(100),
  ADD COLUMN "error_message" VARCHAR(2000),
  ADD COLUMN "canonical_organization_id" VARCHAR(191),
  ADD COLUMN "canonical_venue_id" VARCHAR(191),
  ADD COLUMN "canonical_contact_id" VARCHAR(191),
  ADD COLUMN "canonical_evidence_id" VARCHAR(191),
  ADD COLUMN "canonical_draft_id" VARCHAR(191),
  ADD COLUMN "processed_at" TIMESTAMP(3);

CREATE INDEX "prospect_import_source_records_claim_idx"
  ON "prospect_import_source_records"("import_id", "processing_status", "record_kind", "claim_expires_at");
