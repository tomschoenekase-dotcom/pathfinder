CREATE TYPE "CharacterFactoryJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "CharacterFactoryJobAction" AS ENUM ('CREATE_FROM_IMPORT', 'REVISE', 'INSPECT', 'PREVIEW', 'VALIDATE', 'EXPORT');

CREATE TABLE "character_factory_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "request_id" VARCHAR(191) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "action" "CharacterFactoryJobAction" NOT NULL,
    "status" "CharacterFactoryJobStatus" NOT NULL DEFAULT 'QUEUED',
    "request_payload" JSONB NOT NULL,
    "result_payload" JSONB,
    "error_code" VARCHAR(100),
    "error_message" VARCHAR(1000),
    "custom_character_id" TEXT,
    "base_version" INTEGER,
    "base_revision" INTEGER,
    "result_version" INTEGER,
    "result_revision" INTEGER,
    "attempt_number" INTEGER NOT NULL DEFAULT 0,
    "lease_token" VARCHAR(191),
    "lease_expires_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "cancel_requested_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "character_factory_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_factory_jobs_tenant_id_request_id_key" ON "character_factory_jobs"("tenant_id", "request_id");
CREATE INDEX "character_factory_jobs_tenant_id_venue_id_status_created_at_idx" ON "character_factory_jobs"("tenant_id", "venue_id", "status", "created_at");
CREATE INDEX "character_factory_jobs_status_lease_expires_at_idx" ON "character_factory_jobs"("status", "lease_expires_at");
CREATE INDEX "character_factory_jobs_tenant_id_venue_id_custom_character_id_created_at_idx" ON "character_factory_jobs"("tenant_id", "venue_id", "custom_character_id", "created_at");

ALTER TABLE "character_factory_jobs" ADD CONSTRAINT "character_factory_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_factory_jobs" ADD CONSTRAINT "character_factory_jobs_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "character_factory_jobs" ADD CONSTRAINT "character_factory_jobs_custom_character_id_tenant_id_venue_id_fkey" FOREIGN KEY ("custom_character_id", "tenant_id", "venue_id") REFERENCES "custom_characters"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
