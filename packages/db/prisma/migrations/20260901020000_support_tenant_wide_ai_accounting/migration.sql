-- Tenant-wide AI workloads must not be falsely attributed to one venue.
ALTER TABLE "ai_usage_events" ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "ai_usage_daily_rollups" ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "ai_cost_reservations" ALTER COLUMN "venue_id" DROP NOT NULL;

-- Venue-free usage cannot claim a venue-scoped conversation identity.
ALTER TABLE "ai_usage_events"
ADD CONSTRAINT "ai_usage_events_tenant_wide_scope_check"
CHECK (
  "venue_id" IS NOT NULL
  OR ("session_id" IS NULL AND "client_assistant_turn_id" IS NULL)
);

-- PostgreSQL ordinary unique constraints treat NULL values as distinct. These
-- partial indexes preserve replay/rollup identity for tenant-wide rows.
CREATE UNIQUE INDEX "ai_usage_events_tenant_provider_request_key"
ON "ai_usage_events" ("tenant_id", "provider", "provider_request_id")
WHERE "venue_id" IS NULL AND "provider_request_id" IS NOT NULL;

CREATE UNIQUE INDEX "ai_usage_daily_rollups_tenant_wide_key"
ON "ai_usage_daily_rollups" ("tenant_id", "date", "feature")
WHERE "venue_id" IS NULL;
