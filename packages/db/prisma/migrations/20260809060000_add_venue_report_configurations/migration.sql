-- Weekly reports are an explicit per-venue capability. Existing venues remain
-- disabled because no configuration rows are backfilled.
BEGIN;

CREATE UNIQUE INDEX "venues_id_tenant_id_key" ON "venues"("id", "tenant_id");

CREATE TABLE "venue_report_configurations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_report_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "venue_report_configurations_venue_id_key"
ON "venue_report_configurations"("venue_id");

CREATE UNIQUE INDEX "venue_report_configurations_venue_id_tenant_id_key"
ON "venue_report_configurations"("venue_id", "tenant_id");

CREATE INDEX "venue_report_configurations_tenant_id_enabled_venue_id_idx"
ON "venue_report_configurations"("tenant_id", "enabled", "venue_id");

ALTER TABLE "venue_report_configurations"
ADD CONSTRAINT "venue_report_configurations_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_report_configurations"
ADD CONSTRAINT "venue_report_configurations_venue_id_tenant_id_fkey"
FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

COMMIT;
