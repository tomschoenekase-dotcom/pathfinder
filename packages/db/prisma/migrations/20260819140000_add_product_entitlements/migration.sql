CREATE TYPE "ProductEntitlementEffect" AS ENUM ('GRANT', 'DENY');
CREATE TYPE "ProductEntitlementOverrideKind" AS ENUM ('EXPLICIT', 'TRIAL', 'PROMOTION', 'ADMIN');

CREATE TABLE "product_plan_capabilities" (
    "id" TEXT NOT NULL,
    "plan_tier" VARCHAR(64) NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_plan_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_entitlement_overrides" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "capability" VARCHAR(100) NOT NULL,
    "effect" "ProductEntitlementEffect" NOT NULL,
    "kind" "ProductEntitlementOverrideKind" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "set_by" VARCHAR(191) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_entitlement_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_entitlement_overrides_window_check"
      CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);

ALTER TABLE "product_plan_capabilities"
  ADD CONSTRAINT "product_plan_capabilities_capability_check"
  CHECK ("capability" IN ('voice','premium-voice','advanced-model','premium-conversation','employee-mode','analytics-plus','custom-bot','branded-bot','custom-domain','widget','api','location-plus','advanced-actions','knowledge-automation','multi-venue','support-priority'));

ALTER TABLE "product_entitlement_overrides"
  ADD CONSTRAINT "product_entitlement_overrides_capability_check"
  CHECK ("capability" IN ('voice','premium-voice','advanced-model','premium-conversation','employee-mode','analytics-plus','custom-bot','branded-bot','custom-domain','widget','api','location-plus','advanced-actions','knowledge-automation','multi-venue','support-priority'));

CREATE UNIQUE INDEX "product_plan_capabilities_plan_tier_capability_key"
  ON "product_plan_capabilities"("plan_tier", "capability");
CREATE INDEX "product_plan_capabilities_capability_enabled_idx"
  ON "product_plan_capabilities"("capability", "enabled");
CREATE UNIQUE INDEX "product_entitlement_overrides_id_tenant_id_key"
  ON "product_entitlement_overrides"("id", "tenant_id");
CREATE INDEX "product_entitlement_overrides_tenant_venue_capability_idx"
  ON "product_entitlement_overrides"("tenant_id", "venue_id", "capability", "starts_at", "created_at");
CREATE INDEX "product_entitlement_overrides_tenant_capability_idx"
  ON "product_entitlement_overrides"("tenant_id", "capability", "starts_at", "created_at");

ALTER TABLE "product_entitlement_overrides"
  ADD CONSTRAINT "product_entitlement_overrides_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "product_entitlement_overrides"
  ADD CONSTRAINT "product_entitlement_overrides_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
