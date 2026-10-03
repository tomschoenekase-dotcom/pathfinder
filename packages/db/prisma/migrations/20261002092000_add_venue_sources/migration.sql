BEGIN;

-- Operator-requested public web sources, frozen as evidence. Forward-only and additive: two new
-- tenant-scoped tables and two enums. Nothing here changes existing rows, grants authority, or
-- changes what guests see; a source is evidence only and never becomes content by itself.

CREATE TYPE "VenueSourceStatus" AS ENUM ('REQUESTED', 'FETCHING', 'SUCCEEDED', 'PARTIAL', 'FAILED');
CREATE TYPE "VenueSourceInputDisposition" AS ENUM ('SUCCEEDED', 'PARTIAL', 'FAILED', 'UNSUPPORTED', 'SKIPPED');

CREATE TABLE "venue_sources" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "request_url" VARCHAR(2000) NOT NULL,
  "host" VARCHAR(255) NOT NULL,
  "note" VARCHAR(500),
  "status" "VenueSourceStatus" NOT NULL DEFAULT 'REQUESTED',
  "max_pages" INTEGER NOT NULL,
  "max_bytes_per_page" INTEGER NOT NULL,
  "parser_version" VARCHAR(64) NOT NULL,
  "operation_id" UUID NOT NULL,
  "requested_by" VARCHAR(191) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(64),
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "venue_source_inputs" (
  "id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "requested_url" VARCHAR(2000) NOT NULL,
  "final_url" VARCHAR(2000),
  "redirect_chain" JSONB NOT NULL,
  "disposition" "VenueSourceInputDisposition" NOT NULL,
  "reason_code" VARCHAR(64),
  "http_status" INTEGER,
  "content_type" VARCHAR(200),
  "byte_size" INTEGER,
  "content_hash" CHAR(64),
  "retrieved_at" TIMESTAMP(3) NOT NULL,
  "parser_version" VARCHAR(64) NOT NULL,
  "extracted_text" TEXT,
  "text_truncated" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_source_inputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "venue_sources_scope_key" ON "venue_sources"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "venue_sources_tenant_operation_key" ON "venue_sources"("tenant_id", "operation_id");
CREATE INDEX "venue_sources_scope_requested_idx" ON "venue_sources"("tenant_id", "venue_id", "requested_at");
CREATE INDEX "venue_sources_status_requested_idx" ON "venue_sources"("status", "requested_at");

CREATE UNIQUE INDEX "venue_source_inputs_ordinal_key" ON "venue_source_inputs"("source_id", "ordinal");
CREATE UNIQUE INDEX "venue_source_inputs_scope_key" ON "venue_source_inputs"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_source_inputs_scope_idx" ON "venue_source_inputs"("tenant_id", "venue_id", "source_id");

ALTER TABLE "venue_sources"
  ADD CONSTRAINT "venue_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_sources_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id")
    REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_source_inputs"
  ADD CONSTRAINT "venue_source_inputs_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_source_inputs_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id")
    REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_source_inputs_source_id_tenant_id_venue_id_fkey" FOREIGN KEY ("source_id", "tenant_id", "venue_id")
    REFERENCES "venue_sources"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Frozen snapshots are append-only: a stored input can never be rewritten or removed.
CREATE OR REPLACE FUNCTION "venue_source_inputs_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'venue_source_inputs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "venue_source_inputs_no_update"
  BEFORE UPDATE OR DELETE ON "venue_source_inputs"
  FOR EACH ROW EXECUTE FUNCTION "venue_source_inputs_append_only"();

COMMIT;
