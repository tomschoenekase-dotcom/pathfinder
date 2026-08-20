CREATE TYPE "VenueLocationKind" AS ENUM ('VENUE', 'FLOOR', 'ZONE', 'ROOM', 'POI', 'ENTRANCE', 'EXIT', 'RESTROOM', 'EXHIBIT', 'ACCESSIBILITY_POINT', 'SERVICE_DESK', 'FOOD', 'PARKING');
CREATE TYPE "VenueLocationConnectionKind" AS ENUM ('WALKWAY', 'DOOR', 'STAIRS', 'ELEVATOR', 'ESCALATOR', 'OUTDOOR_PATH', 'SHUTTLE');

CREATE TABLE "venue_floors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "stable_key" VARCHAR(100) NOT NULL, "name" VARCHAR(160) NOT NULL, "level" INTEGER,
  "sort_order" INTEGER NOT NULL DEFAULT 0, "map_image_url" VARCHAR(2000), "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_floors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "venue_floors_tenant_id_venue_id_stable_key_key" ON "venue_floors"("tenant_id", "venue_id", "stable_key");
CREATE UNIQUE INDEX "venue_floors_id_tenant_id_venue_id_key" ON "venue_floors"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_floors_tenant_id_venue_id_sort_order_idx" ON "venue_floors"("tenant_id", "venue_id", "sort_order");

CREATE TABLE "venue_locations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "floor_id" UUID, "parent_location_id" UUID, "stable_key" VARCHAR(100) NOT NULL,
  "kind" "VenueLocationKind" NOT NULL, "display_name" VARCHAR(191) NOT NULL, "description" VARCHAR(2000),
  "visibility" VARCHAR(32) NOT NULL DEFAULT 'PUBLIC', "latitude" DECIMAL(10,7), "longitude" DECIMAL(10,7),
  "map_x" DECIMAL(12,4), "map_y" DECIMAL(12,4), "external_map_reference" VARCHAR(2000),
  "accessibility_metadata" JSONB NOT NULL DEFAULT '{}', "verified_at" TIMESTAMP(3) NOT NULL,
  "verified_by" VARCHAR(191) NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_locations_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'SECOND_LAYER')),
  CONSTRAINT "venue_locations_lat_lng_pair_check" CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  CONSTRAINT "venue_locations_latitude_check" CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  CONSTRAINT "venue_locations_longitude_check" CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180)),
  CONSTRAINT "venue_locations_map_pair_check" CHECK (("map_x" IS NULL) = ("map_y" IS NULL))
);
CREATE UNIQUE INDEX "venue_locations_tenant_id_venue_id_stable_key_key" ON "venue_locations"("tenant_id", "venue_id", "stable_key");
CREATE UNIQUE INDEX "venue_locations_id_tenant_id_venue_id_key" ON "venue_locations"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_locations_tenant_id_venue_id_kind_is_active_idx" ON "venue_locations"("tenant_id", "venue_id", "kind", "is_active");
CREATE INDEX "venue_locations_floor_id_idx" ON "venue_locations"("floor_id");

CREATE TABLE "venue_location_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "from_location_id" UUID NOT NULL, "to_location_id" UUID NOT NULL, "kind" "VenueLocationConnectionKind" NOT NULL,
  "bidirectional" BOOLEAN NOT NULL DEFAULT true, "accessible" BOOLEAN NOT NULL DEFAULT false,
  "directions" VARCHAR(2000), "verified_at" TIMESTAMP(3) NOT NULL, "verified_by" VARCHAR(191) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "venue_location_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_location_connections_distinct_check" CHECK ("from_location_id" <> "to_location_id")
);
CREATE UNIQUE INDEX "venue_location_connections_tenant_id_venue_id_from_location_id_to_location_id_kind_key" ON "venue_location_connections"("tenant_id", "venue_id", "from_location_id", "to_location_id", "kind");
CREATE INDEX "venue_location_connections_tenant_id_venue_id_is_active_idx" ON "venue_location_connections"("tenant_id", "venue_id", "is_active");

ALTER TABLE "venue_floors"
  ADD CONSTRAINT "venue_floors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_floors_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_locations"
  ADD CONSTRAINT "venue_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_locations_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_locations_floor_id_tenant_id_venue_id_fkey" FOREIGN KEY ("floor_id", "tenant_id", "venue_id") REFERENCES "venue_floors"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_locations_parent_location_id_tenant_id_venue_id_fkey" FOREIGN KEY ("parent_location_id", "tenant_id", "venue_id") REFERENCES "venue_locations"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_location_connections"
  ADD CONSTRAINT "venue_location_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_location_connections_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_location_connections_from_location_id_tenant_id_venue_id_fkey" FOREIGN KEY ("from_location_id", "tenant_id", "venue_id") REFERENCES "venue_locations"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_location_connections_to_location_id_tenant_id_venue_id_fkey" FOREIGN KEY ("to_location_id", "tenant_id", "venue_id") REFERENCES "venue_locations"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
