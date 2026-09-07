CREATE TYPE "MediaProviderDispatchState" AS ENUM ('PREPARED', 'DISPATCHED');
CREATE TYPE "MediaProviderOutcomeState" AS ENUM ('PENDING', 'OBSERVED', 'FAILED', 'AMBIGUOUS');
CREATE TYPE "MediaProviderCleanupState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'CONFIRMED');
CREATE TYPE "MediaProviderAccountingState" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SETTLED', 'AMBIGUOUS');

CREATE UNIQUE INDEX "media_ingestion_projects_id_tenant_id_venue_id_key"
  ON "media_ingestion_projects"("id", "tenant_id", "venue_id");

CREATE TABLE "media_provider_operations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "upload_attempt_id" UUID NOT NULL,
  "source_id" VARCHAR(191) NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "model" VARCHAR(96) NOT NULL,
  "method" VARCHAR(96) NOT NULL,
  "input_sha256" CHAR(64) NOT NULL,
  "prompt_sha256" CHAR(64) NOT NULL,
  "extraction_schema_version" VARCHAR(64) NOT NULL,
  "planned_provider_file_name" VARCHAR(255) NOT NULL,
  "dispatch_state" "MediaProviderDispatchState" NOT NULL DEFAULT 'PREPARED',
  "outcome_state" "MediaProviderOutcomeState" NOT NULL DEFAULT 'PENDING',
  "cleanup_state" "MediaProviderCleanupState" NOT NULL DEFAULT 'NOT_REQUIRED',
  "accounting_state" "MediaProviderAccountingState" NOT NULL DEFAULT 'NOT_REQUIRED',
  "budget_reservation_id" TEXT,
  "result" JSONB,
  "response_sha256" CHAR(64),
  "usage" JSONB,
  "error_code" VARCHAR(96),
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "dispatched_at" TIMESTAMP(3),
  "output_observed_at" TIMESTAMP(3),
  "cleanup_confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_provider_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_provider_operations_hashes_check" CHECK (
    "input_sha256" ~ '^[0-9a-f]{64}$' AND "prompt_sha256" ~ '^[0-9a-f]{64}$' AND
    ("response_sha256" IS NULL OR "response_sha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "media_provider_operations_file_name_check" CHECK (
    "planned_provider_file_name" ~ '^files/[A-Za-z0-9._-]{1,249}$'
  ),
  CONSTRAINT "media_provider_operations_lease_pair_check" CHECK (
    ("lease_token" IS NULL) = ("lease_expires_at" IS NULL)
  ),
  CONSTRAINT "media_provider_operations_result_bound_check" CHECK (
    "result" IS NULL OR octet_length("result"::text) <= 1000000
  ),
  CONSTRAINT "media_provider_operations_usage_bound_check" CHECK (
    "usage" IS NULL OR octet_length("usage"::text) <= 16384
  ),
  CONSTRAINT "media_provider_operations_observed_check" CHECK (
    "outcome_state" <> 'OBSERVED' OR
    ("result" IS NOT NULL AND "response_sha256" IS NOT NULL AND "output_observed_at" IS NOT NULL)
  ),
  CONSTRAINT "media_provider_operations_cleanup_check" CHECK (
    ("cleanup_state" = 'CONFIRMED') = ("cleanup_confirmed_at" IS NOT NULL)
  ),
  CONSTRAINT "media_provider_operations_dispatch_check" CHECK (
    ("dispatch_state" = 'PREPARED' AND "dispatched_at" IS NULL AND "cleanup_state" = 'NOT_REQUIRED') OR
    ("dispatch_state" = 'DISPATCHED' AND "dispatched_at" IS NOT NULL AND "cleanup_state" <> 'NOT_REQUIRED')
  )
);

CREATE UNIQUE INDEX "media_provider_operations_identity_key"
  ON "media_provider_operations"("tenant_id", "project_id", "upload_attempt_id", "source_id", "method");
CREATE UNIQUE INDEX "media_provider_operations_id_tenant_id_key"
  ON "media_provider_operations"("id", "tenant_id");
CREATE INDEX "media_provider_operations_cleanup_lease_idx"
  ON "media_provider_operations"("tenant_id", "venue_id", "cleanup_state", "lease_expires_at");
CREATE INDEX "media_provider_operations_project_attempt_idx"
  ON "media_provider_operations"("project_id", "upload_attempt_id");

ALTER TABLE "media_provider_operations" ADD CONSTRAINT "media_provider_operations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "media_provider_operations" ADD CONSTRAINT "media_provider_operations_venue_tenant_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "media_provider_operations" ADD CONSTRAINT "media_provider_operations_project_scope_fkey"
  FOREIGN KEY ("project_id", "tenant_id", "venue_id") REFERENCES "media_ingestion_projects"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_media_provider_operation_identity_update"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."tenant_id", NEW."venue_id", NEW."project_id", NEW."upload_attempt_id", NEW."source_id", NEW."provider", NEW."model", NEW."method", NEW."input_sha256", NEW."prompt_sha256", NEW."extraction_schema_version", NEW."planned_provider_file_name") IS DISTINCT FROM
     ROW(OLD."tenant_id", OLD."venue_id", OLD."project_id", OLD."upload_attempt_id", OLD."source_id", OLD."provider", OLD."model", OLD."method", OLD."input_sha256", OLD."prompt_sha256", OLD."extraction_schema_version", OLD."planned_provider_file_name") THEN
    RAISE EXCEPTION 'media provider operation identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "media_provider_operations_identity_immutable"
BEFORE UPDATE ON "media_provider_operations"
FOR EACH ROW EXECUTE FUNCTION "prevent_media_provider_operation_identity_update"();
