BEGIN;

CREATE TYPE "IntakeFileExtractionOutcome" AS ENUM ('SUCCEEDED', 'FAILED');
ALTER TYPE "IntakeEventKind" ADD VALUE 'FILE_EXTRACTION_RECORDED';

ALTER TABLE "intake_uploads" DROP CONSTRAINT "intake_uploads_metadata_check";
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_metadata_check" CHECK (
  "mime_type" IN (
    'application/pdf',
    'application/json',
    'text/plain',
    'text/markdown',
    'text/csv',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/tiff',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/webm'
  ) AND
  "byte_size" BETWEEN 1 AND 2000000000 AND
  "sha256" ~ '^[a-f0-9]{64}$' AND
  "request_hash" ~ '^[a-f0-9]{64}$' AND
  char_length(btrim("display_name")) BETWEEN 1 AND 255 AND
  char_length(btrim("file_name")) BETWEEN 1 AND 255 AND
  "requested_by_role" IN ('STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN')
);

CREATE TABLE "intake_file_extraction_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "upload_id" TEXT NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "outcome" "IntakeFileExtractionOutcome" NOT NULL,
  "source_object_generation" UUID NOT NULL,
  "source_storage_version_id" VARCHAR(1024) NOT NULL,
  "source_sha256" CHAR(64) NOT NULL,
  "source_byte_size" INTEGER NOT NULL,
  "source_mime_type" VARCHAR(64) NOT NULL,
  "extractor" VARCHAR(64) NOT NULL,
  "extractor_version" VARCHAR(64) NOT NULL,
  "extracted_text" TEXT,
  "extracted_text_hash" CHAR(64),
  "extracted_character_count" INTEGER NOT NULL DEFAULT 0,
  "extracted_line_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(64),
  "error_message" VARCHAR(500),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_file_extraction_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_file_extraction_receipts_hashes_check" CHECK (
    "request_hash" ~ '^[a-f0-9]{64}$' AND
    "source_sha256" ~ '^[a-f0-9]{64}$' AND
    ("extracted_text_hash" IS NULL OR "extracted_text_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "intake_file_extraction_receipts_source_check" CHECK (
    "source_byte_size" BETWEEN 1 AND 2097152 AND
    "source_mime_type" IN ('application/json', 'text/plain', 'text/markdown', 'text/csv')
  ),
  CONSTRAINT "intake_file_extraction_receipts_counts_check" CHECK (
    "extracted_character_count" >= 0 AND "extracted_line_count" >= 0
  ),
  CONSTRAINT "intake_file_extraction_receipts_terminal_shape_check" CHECK (
    (
      "outcome" = 'SUCCEEDED' AND
      "extracted_text" IS NOT NULL AND
      "extracted_text_hash" IS NOT NULL AND
      "extracted_character_count" > 0 AND
      "extracted_line_count" > 0 AND
      "error_code" IS NULL AND
      "error_message" IS NULL
    ) OR (
      "outcome" = 'FAILED' AND
      "extracted_text" IS NULL AND
      "extracted_text_hash" IS NULL AND
      "extracted_character_count" = 0 AND
      "extracted_line_count" = 0 AND
      "error_code" IS NOT NULL AND
      "error_message" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "intake_file_extraction_receipts_request_key" ON "intake_file_extraction_receipts"("tenant_id", "request_id");
CREATE UNIQUE INDEX "intake_file_extraction_receipts_extractor_key" ON "intake_file_extraction_receipts"("upload_id", "extractor", "extractor_version");
CREATE UNIQUE INDEX "intake_file_extraction_receipts_scope_key" ON "intake_file_extraction_receipts"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_file_extraction_receipts_run_created_idx" ON "intake_file_extraction_receipts"("tenant_id", "venue_id", "run_id", "created_at");

ALTER TABLE "intake_file_extraction_receipts" ADD CONSTRAINT "intake_file_extraction_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_receipts" ADD CONSTRAINT "intake_file_extraction_receipts_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_receipts" ADD CONSTRAINT "intake_file_extraction_receipts_run_scope_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_extraction_receipts" ADD CONSTRAINT "intake_file_extraction_receipts_upload_scope_fkey" FOREIGN KEY ("upload_id", "tenant_id", "venue_id") REFERENCES "intake_uploads"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_intake_file_extraction_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER intake_file_extraction_receipts_append_only BEFORE UPDATE OR DELETE ON "intake_file_extraction_receipts" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_file_extraction_receipt_mutation();
CREATE TRIGGER intake_file_extraction_receipts_no_truncate BEFORE TRUNCATE ON "intake_file_extraction_receipts" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_file_extraction_receipt_mutation();

COMMIT;
