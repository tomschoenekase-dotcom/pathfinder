BEGIN;

ALTER TABLE "media_ingestion_projects"
  ADD COLUMN "provider_operation_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "media_ingestion_projects"
  ADD CONSTRAINT "media_ingestion_projects_provider_operation_count_check"
  CHECK ("provider_operation_count" >= 0 AND "provider_operation_count" <= 10000);

COMMIT;
