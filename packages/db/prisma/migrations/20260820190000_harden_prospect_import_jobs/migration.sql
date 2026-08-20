ALTER TYPE "ProspectImportRowStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "ProspectImportRowStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';
ALTER TYPE "ProspectImportStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "ProspectImportStatus" ADD VALUE IF NOT EXISTS 'REPAIRED';

CREATE TYPE "ProspectImportRowDecision" AS ENUM (
  'CREATE_DISTINCT',
  'LINK_EXISTING',
  'UPDATE_EXISTING',
  'SKIP',
  'QUARANTINE',
  'NOT_DUPLICATE'
);

ALTER TABLE "prospect_imports"
  ADD COLUMN "source_object_key" VARCHAR(500),
  ADD COLUMN "source_object_version" VARCHAR(500),
  ADD COLUMN "source_object_generation" UUID,
  ADD COLUMN "expanded_size_bytes" INTEGER,
  ADD COLUMN "progress_cursor" VARCHAR(500),
  ADD COLUMN "job_claim_token" UUID,
  ADD COLUMN "job_claim_phase" VARCHAR(50),
  ADD COLUMN "job_claim_owner" VARCHAR(191),
  ADD COLUMN "job_claim_expires_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "canceled_by" VARCHAR(191),
  ADD COLUMN "report_object_key" VARCHAR(500),
  ADD COLUMN "report_hash" CHAR(64),
  ADD COLUMN "reconciliation" JSONB,
  ADD COLUMN "completed_at" TIMESTAMP(3);

ALTER TABLE "prospect_import_sheets"
  ADD COLUMN "selected" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "prospect_imports_status_job_claim_expires_at_idx"
ON "prospect_imports"("status", "job_claim_expires_at");

ALTER TABLE "prospect_import_rows"
  ADD COLUMN "decision" "ProspectImportRowDecision",
  ADD COLUMN "decision_note" VARCHAR(2000),
  ADD COLUMN "decision_by" VARCHAR(191),
  ADD COLUMN "decision_at" TIMESTAMP(3),
  ADD COLUMN "target_organization_id" TEXT,
  ADD COLUMN "target_venue_id" TEXT,
  ADD COLUMN "target_contact_id" TEXT,
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "claim_owner" VARCHAR(191),
  ADD COLUMN "claim_expires_at" TIMESTAMP(3);

CREATE INDEX "prospect_import_rows_import_id_status_claim_expires_at_original_row_number_idx"
ON "prospect_import_rows"("import_id", "status", "claim_expires_at", "original_row_number");

ALTER TABLE "prospect_imports"
  ADD CONSTRAINT "prospect_imports_expanded_size_nonnegative"
  CHECK ("expanded_size_bytes" IS NULL OR "expanded_size_bytes" >= 0);

ALTER TABLE "prospect_import_rows"
  ADD CONSTRAINT "prospect_import_rows_decision_target_shape"
  CHECK (
    ("decision" IN ('LINK_EXISTING', 'UPDATE_EXISTING') AND "target_organization_id" IS NOT NULL)
    OR ("decision" NOT IN ('LINK_EXISTING', 'UPDATE_EXISTING'))
    OR "decision" IS NULL
  );

ALTER TABLE "prospect_import_rows"
  ADD CONSTRAINT "prospect_import_rows_target_organization_fkey"
  FOREIGN KEY ("target_organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "prospect_import_rows_target_venue_fkey"
  FOREIGN KEY ("target_venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "prospect_import_rows_target_contact_fkey"
  FOREIGN KEY ("target_contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT;

CREATE TABLE "prospect_import_report_entries" (
  "id" TEXT NOT NULL,
  "import_id" TEXT NOT NULL,
  "import_row_id" TEXT NOT NULL,
  "sheet_name" VARCHAR(300) NOT NULL,
  "original_row_number" INTEGER NOT NULL,
  "row_fingerprint" CHAR(64) NOT NULL,
  "status" "ProspectImportRowStatus" NOT NULL,
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "errors" JSONB NOT NULL DEFAULT '[]',
  "duplicate_matches" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_import_report_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_import_report_entries_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "prospect_imports"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "prospect_import_report_entries_import_id_import_row_id_key"
ON "prospect_import_report_entries"("import_id", "import_row_id");
CREATE INDEX "prospect_import_report_entries_import_id_sheet_name_original_row_number_idx"
ON "prospect_import_report_entries"("import_id", "sheet_name", "original_row_number");

CREATE TRIGGER "prospect_import_report_entries_append_only_update_delete"
BEFORE UPDATE OR DELETE ON "prospect_import_report_entries"
FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "prospect_import_report_entries_append_only_truncate"
BEFORE TRUNCATE ON "prospect_import_report_entries"
FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
