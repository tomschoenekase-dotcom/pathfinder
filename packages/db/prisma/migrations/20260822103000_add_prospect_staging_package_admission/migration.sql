ALTER TABLE "prospect_imports"
  ADD COLUMN "package_schema_version" VARCHAR(64),
  ADD COLUMN "package_hash" CHAR(64),
  ADD COLUMN "source_workbook_hash" CHAR(64),
  ADD COLUMN "package_manifest" JSONB;

CREATE UNIQUE INDEX "prospect_imports_package_hash_key"
  ON "prospect_imports"("package_hash");

CREATE TABLE "prospect_import_source_records" (
  "id" TEXT NOT NULL,
  "import_id" TEXT NOT NULL,
  "source_system" VARCHAR(64) NOT NULL,
  "source_workbook_hash" CHAR(64) NOT NULL,
  "record_kind" VARCHAR(64) NOT NULL,
  "external_record_id" VARCHAR(191) NOT NULL,
  "parent_external_id" VARCHAR(191),
  "record_hash" CHAR(64) NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "normalized_payload" JSONB NOT NULL,
  "source_status" VARCHAR(100) NOT NULL,
  "canonical_record_type" VARCHAR(64),
  "canonical_record_id" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_import_source_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_import_source_records_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "prospect_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "prospect_import_source_records_stable_identity_key"
  ON "prospect_import_source_records"("source_system", "source_workbook_hash", "record_kind", "external_record_id");
CREATE INDEX "prospect_import_source_records_import_kind_status_idx"
  ON "prospect_import_source_records"("import_id", "record_kind", "source_status");
CREATE INDEX "prospect_import_source_records_canonical_idx"
  ON "prospect_import_source_records"("canonical_record_type", "canonical_record_id");
