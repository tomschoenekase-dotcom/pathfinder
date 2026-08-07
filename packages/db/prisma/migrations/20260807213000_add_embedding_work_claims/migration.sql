CREATE TYPE "EmbeddingWorkEntityType" AS ENUM ('PLACE', 'KNOWLEDGE_ENTRY');
CREATE TYPE "EmbeddingWorkClaimStatus" AS ENUM ('RUNNING', 'COMPLETE', 'SUPERSEDED');

CREATE TABLE "embedding_work_claims" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "entity_type" "EmbeddingWorkEntityType" NOT NULL,
  "entity_id" TEXT NOT NULL,
  "content_updated_at" TIMESTAMP(3) NOT NULL,
  "source_hash" TEXT NOT NULL,
  "embedding_profile" TEXT NOT NULL,
  "status" "EmbeddingWorkClaimStatus" NOT NULL DEFAULT 'RUNNING',
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "embedding_work_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_work_claims_source_hash_check" CHECK ("source_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "embedding_work_claims_lease_state_check" CHECK (
    ("status" = 'RUNNING' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "completed_at" IS NULL)
    OR
    ("status" IN ('COMPLETE', 'SUPERSEDED') AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "embedding_work_claims_entity_key"
  ON "embedding_work_claims"("tenant_id", "venue_id", "entity_type", "entity_id");
CREATE INDEX "embedding_work_claims_tenant_id_status_lease_expires_at_idx"
  ON "embedding_work_claims"("tenant_id", "status", "lease_expires_at");
CREATE INDEX "embedding_work_claims_tenant_id_entity_type_entity_id_created_at_idx"
  ON "embedding_work_claims"("tenant_id", "entity_type", "entity_id", "created_at");

ALTER TABLE "embedding_work_claims"
  ADD CONSTRAINT "embedding_work_claims_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "embedding_work_claims"
  ADD CONSTRAINT "embedding_work_claims_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
