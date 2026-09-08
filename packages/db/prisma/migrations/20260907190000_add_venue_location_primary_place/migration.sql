ALTER TABLE "venue_locations"
ADD COLUMN "primary_place_id" TEXT;

CREATE INDEX "venue_locations_primary_place_scope_idx"
ON "venue_locations"("tenant_id", "venue_id", "primary_place_id");

ALTER TABLE "venue_locations"
ADD CONSTRAINT "venue_locations_primary_place_id_tenant_id_venue_id_fkey"
FOREIGN KEY ("primary_place_id", "tenant_id", "venue_id")
REFERENCES "places"("id", "tenant_id", "venue_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;
