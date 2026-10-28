-- Durable manual refresh receipts. Unknown attempts retain the venue lock indefinitely.
CREATE TYPE "EmbeddingVenueRefreshStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN');
CREATE TYPE "EmbeddingVenueRefreshRecordStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'OUTCOME_UNKNOWN');
CREATE TABLE "embedding_venue_refreshes" (
 "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "venue_id" TEXT NOT NULL REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "operation_key" TEXT NOT NULL, "plan_digest" TEXT NOT NULL, "max_records" INTEGER NOT NULL CHECK (max_records BETWEEN 0 AND 1000),
 "requested_by" TEXT NOT NULL, "status" "EmbeddingVenueRefreshStatus" NOT NULL DEFAULT 'QUEUED',
 "before_audit" JSONB NOT NULL, "after_audit" JSONB, "stop_code" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "embedding_venue_refreshes_operation_key_key" ON "embedding_venue_refreshes"("operation_key");
CREATE UNIQUE INDEX "embedding_venue_refreshes_tenant_id_venue_id_id_key" ON "embedding_venue_refreshes"("tenant_id", "venue_id", "id");
CREATE INDEX "embedding_venue_refreshes_tenant_id_venue_id_created_at_idx" ON "embedding_venue_refreshes"("tenant_id", "venue_id", "created_at");
CREATE UNIQUE INDEX "embedding_venue_refreshes_active_venue_key" ON "embedding_venue_refreshes"("tenant_id", "venue_id") WHERE status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN');
CREATE TABLE "embedding_venue_refresh_records" (
 "id" TEXT PRIMARY KEY, "refresh_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
 "ordinal" INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 999), "entity_type" "EmbeddingWorkEntityType" NOT NULL CHECK (entity_type IN ('PLACE', 'KNOWLEDGE_ENTRY')),
 "entity_id" TEXT NOT NULL, "content_updated_at" TIMESTAMP(3) NOT NULL, "source_hash" TEXT NOT NULL, "embedding_profile" TEXT NOT NULL,
 "primary_reason" TEXT NOT NULL, "status" "EmbeddingVenueRefreshRecordStatus" NOT NULL DEFAULT 'PENDING', "outcome" TEXT,
 "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3),
 CONSTRAINT "embedding_venue_refresh_records_scope_fkey" FOREIGN KEY ("tenant_id", "venue_id", "refresh_id") REFERENCES "embedding_venue_refreshes"("tenant_id", "venue_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "embedding_venue_refresh_records_refresh_id_ordinal_key" ON "embedding_venue_refresh_records"("refresh_id", "ordinal");
CREATE UNIQUE INDEX "embedding_venue_refresh_records_refresh_id_entity_type_entity_id_key" ON "embedding_venue_refresh_records"("refresh_id", "entity_type", "entity_id");
CREATE INDEX "embedding_venue_refresh_records_tenant_id_venue_id_refresh_id_idx" ON "embedding_venue_refresh_records"("tenant_id", "venue_id", "refresh_id");
