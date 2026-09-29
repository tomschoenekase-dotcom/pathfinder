CREATE TYPE "DistributionState" AS ENUM ('DISABLED', 'ENABLED');
CREATE TYPE "WebsiteOriginState" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "VisitorEntrySurface" AS ENUM ('DIRECT', 'QR', 'WEBSITE', 'APP');

-- Expand both closed entitlement checks before the app-webview plan backfill.
ALTER TABLE "product_plan_capabilities" DROP CONSTRAINT "product_plan_capabilities_capability_check";
ALTER TABLE "product_plan_capabilities"
  ADD CONSTRAINT "product_plan_capabilities_capability_check"
  CHECK ("capability" IN ('voice','premium-voice','advanced-model','premium-conversation','employee-mode','analytics-plus','custom-bot','branded-bot','custom-domain','widget','app-webview','api','location-plus','advanced-actions','knowledge-automation','multi-venue','support-priority'));
ALTER TABLE "product_entitlement_overrides" DROP CONSTRAINT "product_entitlement_overrides_capability_check";
ALTER TABLE "product_entitlement_overrides"
  ADD CONSTRAINT "product_entitlement_overrides_capability_check"
  CHECK ("capability" IN ('voice','premium-voice','advanced-model','premium-conversation','employee-mode','analytics-plus','custom-bot','branded-bot','custom-domain','widget','app-webview','api','location-plus','advanced-actions','knowledge-automation','multi-venue','support-priority'));

CREATE TABLE "venue_distributions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "website_state" "DistributionState" NOT NULL DEFAULT 'DISABLED',
    "app_state" "DistributionState" NOT NULL DEFAULT 'DISABLED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by" VARCHAR(191) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_distributions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "venue_website_origins" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "origin" VARCHAR(255) NOT NULL,
    "state" "WebsiteOriginState" NOT NULL DEFAULT 'ACTIVE',
    "added_by" VARCHAR(191) NOT NULL,
    "added_reason" VARCHAR(500) NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" VARCHAR(191),
    "revoked_reason" VARCHAR(500),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "venue_website_origins_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_website_origins_state_revoked_check" CHECK (
      ("state" = 'ACTIVE' AND "revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoked_reason" IS NULL)
      OR ("state" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoked_reason" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "venue_distributions_venue_id_key" ON "venue_distributions"("venue_id");
CREATE UNIQUE INDEX "venue_distributions_venue_id_tenant_id_key" ON "venue_distributions"("venue_id", "tenant_id");
CREATE UNIQUE INDEX "venue_distributions_id_tenant_id_key" ON "venue_distributions"("id", "tenant_id");
CREATE INDEX "venue_distributions_tenant_id_idx" ON "venue_distributions"("tenant_id");
CREATE INDEX "venue_website_origins_tenant_id_venue_id_state_idx" ON "venue_website_origins"("tenant_id", "venue_id", "state");
CREATE UNIQUE INDEX "venue_website_origins_active_origin_key" ON "venue_website_origins"("venue_id", "origin") WHERE "state" = 'ACTIVE';

ALTER TABLE "venue_distributions"
  ADD CONSTRAINT "venue_distributions_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_website_origins"
  ADD CONSTRAINT "venue_website_origins_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "visitor_sessions" ADD COLUMN "entry_surface" "VisitorEntrySurface";

-- Create app entitlements for existing plans without activating the app surface.
INSERT INTO "product_plan_capabilities" (
  "id", "plan_tier", "capability", "enabled", "settings", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT md5('app-webview:' || "id"), "plan_tier", 'app-webview', FALSE, "settings", "created_by", "updated_by", "created_at", "updated_at"
FROM "product_plan_capabilities" AS source
WHERE "capability" = 'widget'
ON CONFLICT ("plan_tier", "capability") DO NOTHING;

-- Admit the two new scoped MCP capabilities for future credentials only.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-improvements:validate','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','characters:build','characters:execute','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','distribution:propose','distribution:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','intake-source:read','intake:draft','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:apply','packages:approve','packages:draft','packages:read','packages:reconcile','packages:revert','questions:ask','questions:read','readiness:read','reports:draft','reports:read','resources:read','retention:read','support:complete','support:draft','support:note','support:open','support:read','support:request-information','support:triage','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported MCP credential capability';
  END IF;
  IF NEW."kind" = 'PARTNER_READ_API' AND (NEW."capabilities" <@ ARRAY['approved-content:read','clients:read','configuration:read','readiness:read','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported partner credential capability';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "external_credential_operation_receipts" receipt WHERE receipt."credential_id" = NEW."id" AND receipt."operation_kind" IN ('ISSUE','ROTATE')) THEN
    RAISE EXCEPTION 'new external credential requires operation evidence';
  END IF;
  IF NEW."enabled" AND NOT EXISTS (
    SELECT 1 FROM "external_credential_activations" activation
      WHERE activation."credential_id" = NEW."id"
        AND activation."tenant_id" = NEW."tenant_id"
        AND activation."client_id" = NEW."client_id"
        AND activation."scope_key" = NEW."scope_key"
        AND activation."activated_at" = NEW."updated_at"
  ) THEN
    RAISE EXCEPTION 'enabled external credential requires exact activation evidence';
  END IF;
  IF NEW."revoked_at" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "external_credential_revocations" revocation WHERE revocation."credential_id" = NEW."id" AND revocation."revoked_at" = NEW."revoked_at") THEN
    RAISE EXCEPTION 'external credential revocation requires exact timestamp evidence';
  END IF;
  RETURN NULL;
END;
$$;
