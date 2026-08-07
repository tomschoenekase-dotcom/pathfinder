CREATE TABLE "ai_usage_daily_rollups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "feature" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "successful_request_count" INTEGER NOT NULL DEFAULT 0,
    "failed_request_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_creation_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_rollups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_usage_daily_rollups_tenant_id_venue_id_date_feature_key"
ON "ai_usage_daily_rollups"("tenant_id", "venue_id", "date", "feature");
CREATE INDEX "ai_usage_daily_rollups_tenant_id_date_idx"
ON "ai_usage_daily_rollups"("tenant_id", "date");
CREATE INDEX "ai_usage_daily_rollups_tenant_id_venue_id_date_idx"
ON "ai_usage_daily_rollups"("tenant_id", "venue_id", "date");
CREATE INDEX "ai_usage_daily_rollups_feature_date_idx"
ON "ai_usage_daily_rollups"("feature", "date");

ALTER TABLE "ai_usage_daily_rollups"
ADD CONSTRAINT "ai_usage_daily_rollups_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_usage_daily_rollups"
ADD CONSTRAINT "ai_usage_daily_rollups_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
