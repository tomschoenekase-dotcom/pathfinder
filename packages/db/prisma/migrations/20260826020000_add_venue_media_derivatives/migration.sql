CREATE TYPE "VenueMediaDerivativeVariant" AS ENUM ('CARD', 'DETAIL');
CREATE TYPE "VenueMediaDerivativeStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "venue_media_derivatives" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "asset_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "variant" "VenueMediaDerivativeVariant" NOT NULL,
  "status" "VenueMediaDerivativeStatus" NOT NULL DEFAULT 'PENDING',
  "source_object_generation" UUID NOT NULL,
  "source_storage_version_id" VARCHAR(1024) NOT NULL,
  "approved_review_sequence" INTEGER NOT NULL,
  "object_key" VARCHAR(255),
  "storage_version_id" VARCHAR(1024),
  "mime_type" VARCHAR(64),
  "width" INTEGER,
  "height" INTEGER,
  "byte_size" INTEGER,
  "sha256" CHAR(64),
  "failure_code" VARCHAR(64),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "venue_media_derivatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_media_derivatives_ready_shape_check" CHECK (
    ("status" = 'READY' AND "object_key" IS NOT NULL AND "storage_version_id" IS NOT NULL
      AND "mime_type" = 'image/webp'
      AND "width" > 0 AND "height" > 0 AND "byte_size" > 0 AND "sha256" IS NOT NULL
      AND "failure_code" IS NULL AND "completed_at" IS NOT NULL)
    OR
    ("status" = 'PENDING' AND "object_key" IS NULL AND "storage_version_id" IS NULL
      AND "mime_type" IS NULL AND "width" IS NULL AND "height" IS NULL
      AND "byte_size" IS NULL AND "sha256" IS NULL AND "failure_code" IS NULL
      AND "completed_at" IS NULL)
    OR
    ("status" = 'FAILED' AND "object_key" IS NULL AND "storage_version_id" IS NULL
      AND "mime_type" IS NULL AND "width" IS NULL AND "height" IS NULL
      AND "byte_size" IS NULL AND "sha256" IS NULL AND "failure_code" IS NOT NULL
      AND "completed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "venue_media_derivatives_object_key_key" ON "venue_media_derivatives"("object_key");
CREATE UNIQUE INDEX "venue_media_derivatives_request_variant_key" ON "venue_media_derivatives"("tenant_id", "request_id", "variant");
CREATE UNIQUE INDEX "venue_media_derivatives_source_variant_key" ON "venue_media_derivatives"("asset_id", "variant", "source_object_generation");
CREATE UNIQUE INDEX "venue_media_derivatives_scope_key" ON "venue_media_derivatives"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_media_derivatives_scope_status_idx" ON "venue_media_derivatives"("tenant_id", "venue_id", "asset_id", "status");

ALTER TABLE "venue_media_derivatives"
  ADD CONSTRAINT "venue_media_derivatives_asset_scope_fkey"
  FOREIGN KEY ("asset_id", "tenant_id", "venue_id")
  REFERENCES "venue_media_assets"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
