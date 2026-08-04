CREATE TYPE "MediaIngestionMode" AS ENUM ('ECONOMY', 'BALANCED', 'FORENSIC');
CREATE TYPE "MediaIngestionStatus" AS ENUM ('DRAFT', 'UPLOADING', 'QUEUED', 'INVENTORYING', 'ANALYZING', 'NEEDS_INPUT', 'SYNTHESIZING', 'READY_FOR_REVIEW', 'COMPLETE', 'FAILED', 'CANCELLED');
CREATE TYPE "MediaIngestionAssetType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT');
CREATE TYPE "MediaIngestionAssetStatus" AS ENUM ('PENDING', 'EXTRACTING', 'READY', 'ANALYZING', 'COMPLETE', 'FAILED', 'SKIPPED');

CREATE TABLE "media_ingestion_projects" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "mode" "MediaIngestionMode" NOT NULL DEFAULT 'BALANCED',
  "status" "MediaIngestionStatus" NOT NULL DEFAULT 'DRAFT',
  "stage" TEXT NOT NULL DEFAULT 'setup',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "source_object_key" TEXT,
  "source_file_name" TEXT,
  "source_bytes" BIGINT,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "coverage" JSONB NOT NULL DEFAULT '{}',
  "questions" JSONB NOT NULL DEFAULT '[]',
  "findings" JSONB NOT NULL DEFAULT '[]',
  "draft_json" JSONB,
  "estimated_cost_cents" INTEGER,
  "actual_cost_cents" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "media_ingestion_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "media_ingestion_assets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "media_type" "MediaIngestionAssetType" NOT NULL,
  "object_key" TEXT NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" TEXT,
  "captured_at" TIMESTAMP(3),
  "status" "MediaIngestionAssetStatus" NOT NULL DEFAULT 'PENDING',
  "analysis" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_ingestion_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "media_ingestion_projects_tenant_id_venue_id_created_at_idx" ON "media_ingestion_projects"("tenant_id", "venue_id", "created_at");
CREATE INDEX "media_ingestion_projects_status_created_at_idx" ON "media_ingestion_projects"("status", "created_at");
CREATE UNIQUE INDEX "media_ingestion_assets_project_id_source_id_key" ON "media_ingestion_assets"("project_id", "source_id");
CREATE INDEX "media_ingestion_assets_tenant_id_project_id_status_idx" ON "media_ingestion_assets"("tenant_id", "project_id", "status");

ALTER TABLE "media_ingestion_projects" ADD CONSTRAINT "media_ingestion_projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_ingestion_projects" ADD CONSTRAINT "media_ingestion_projects_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_ingestion_assets" ADD CONSTRAINT "media_ingestion_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "media_ingestion_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
