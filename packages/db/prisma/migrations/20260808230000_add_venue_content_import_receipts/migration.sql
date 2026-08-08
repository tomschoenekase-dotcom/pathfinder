-- A caller-generated UUID identifies one venue-content import attempt. The
-- receipt is inserted in the same transaction as its places and knowledge,
-- so a committed response can be recovered without duplicating content.
CREATE TABLE "venue_content_import_receipts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "place_count" INTEGER NOT NULL,
  "knowledge_entry_count" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "venue_content_import_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_content_import_receipts_place_count_check"
    CHECK ("place_count" BETWEEN 0 AND 500),
  CONSTRAINT "venue_content_import_receipts_knowledge_entry_count_check"
    CHECK ("knowledge_entry_count" BETWEEN 0 AND 500),
  CONSTRAINT "venue_content_import_receipts_nonempty_check"
    CHECK ("place_count" + "knowledge_entry_count" > 0),
  CONSTRAINT "venue_content_import_receipts_payload_hash_check"
    CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "venue_content_import_receipts_tenant_id_venue_id_idempotency_key_key"
ON "venue_content_import_receipts"("tenant_id", "venue_id", "idempotency_key");

CREATE INDEX "venue_content_import_receipts_tenant_id_venue_id_created_at_idx"
ON "venue_content_import_receipts"("tenant_id", "venue_id", "created_at");

ALTER TABLE "venue_content_import_receipts"
ADD CONSTRAINT "venue_content_import_receipts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "venue_content_import_receipts"
ADD CONSTRAINT "venue_content_import_receipts_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
