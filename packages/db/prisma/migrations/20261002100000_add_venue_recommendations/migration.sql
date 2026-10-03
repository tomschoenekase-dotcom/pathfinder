BEGIN;

-- Venue recommendations (W08): guest-safe catalog facts, a separate OPERATOR-only commercial
-- priority, and a versioned per-venue policy. Additive and forward-only; the capability stays
-- OFF until a policy row is enabled.

-- CreateEnum
CREATE TYPE "CatalogAvailability" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CatalogCommercialPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateTable
CREATE TABLE "venue_catalog_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "stable_key" VARCHAR(100) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "place_id" TEXT,
    "route_note" VARCHAR(500),
    "price_minor" INTEGER,
    "currency" CHAR(3),
    "size_label" VARCHAR(64),
    "price_observed_at" TIMESTAMP(3),
    "effective_from" TIMESTAMP(3),
    "effective_until" TIMESTAMP(3),
    "availability" "CatalogAvailability" NOT NULL DEFAULT 'UNKNOWN',
    "availability_observed_at" TIMESTAMP(3),
    "hours" JSONB NOT NULL DEFAULT '{}',
    "seasonal_windows" JSONB NOT NULL DEFAULT '[]',
    "ingredients" JSONB NOT NULL,
    "allergens" JSONB NOT NULL,
    "dietary" JSONB NOT NULL DEFAULT '{}',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "last_verified_at" TIMESTAMP(3),
    "allowed_claims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_catalog_item_priorities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "audience" "NormalizedContentAudience" NOT NULL DEFAULT 'OPERATOR',
    "priority" "CatalogCommercialPriority" NOT NULL DEFAULT 'NORMAL',
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_catalog_item_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_recommendation_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_boost" INTEGER NOT NULL DEFAULT 3,
    "max_unsolicited_per_session" INTEGER NOT NULL DEFAULT 1,
    "fact_max_age_days" INTEGER NOT NULL DEFAULT 30,
    "availability_max_age_hours" INTEGER NOT NULL DEFAULT 24,
    "expires_at" TIMESTAMP(3),
    "owner_user_id" VARCHAR(191) NOT NULL,
    "owner_label" VARCHAR(200) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_recommendation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venue_catalog_items_tenant_id_venue_id_category_idx" ON "venue_catalog_items"("tenant_id", "venue_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "venue_catalog_items_tenant_id_venue_id_stable_key_key" ON "venue_catalog_items"("tenant_id", "venue_id", "stable_key");

-- CreateIndex
CREATE UNIQUE INDEX "venue_catalog_items_scope_key" ON "venue_catalog_items"("id", "tenant_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_catalog_item_priorities_tenant_id_venue_id_item_id_key" ON "venue_catalog_item_priorities"("tenant_id", "venue_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_catalog_item_priorities_item_scope_key" ON "venue_catalog_item_priorities"("item_id", "tenant_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_recommendation_policies_tenant_id_venue_id_key" ON "venue_recommendation_policies"("tenant_id", "venue_id");

-- AddForeignKey
ALTER TABLE "venue_catalog_items" ADD CONSTRAINT "venue_catalog_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_catalog_items" ADD CONSTRAINT "venue_catalog_items_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_catalog_items" ADD CONSTRAINT "venue_catalog_items_place_id_tenant_id_venue_id_fkey" FOREIGN KEY ("place_id", "tenant_id", "venue_id") REFERENCES "places"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_catalog_item_priorities" ADD CONSTRAINT "venue_catalog_item_priorities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_catalog_item_priorities" ADD CONSTRAINT "venue_catalog_item_priorities_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_catalog_item_priorities" ADD CONSTRAINT "venue_catalog_item_priorities_item_id_tenant_id_venue_id_fkey" FOREIGN KEY ("item_id", "tenant_id", "venue_id") REFERENCES "venue_catalog_items"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_recommendation_policies" ADD CONSTRAINT "venue_recommendation_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "venue_recommendation_policies" ADD CONSTRAINT "venue_recommendation_policies_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Pin invariants the application also enforces.
ALTER TABLE "venue_catalog_item_priorities"
  ADD CONSTRAINT "venue_catalog_item_priorities_operator_only_check" CHECK ("audience" = 'OPERATOR');
ALTER TABLE "venue_catalog_items"
  ADD CONSTRAINT "venue_catalog_items_price_check" CHECK ("price_minor" IS NULL OR "price_minor" >= 0);
ALTER TABLE "venue_recommendation_policies"
  ADD CONSTRAINT "venue_recommendation_policies_bounds_check" CHECK (
    "max_boost" BETWEEN 0 AND 10
    AND "max_unsolicited_per_session" BETWEEN 1 AND 3
    AND "fact_max_age_days" BETWEEN 1 AND 365
    AND "availability_max_age_hours" BETWEEN 1 AND 168
  );

COMMIT;
