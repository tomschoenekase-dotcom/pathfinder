ALTER TABLE "ai_usage_events"
  ADD COLUMN "capability" VARCHAR(64) NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "route_model_key" VARCHAR(100),
  ADD COLUMN "fallback_used" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ai_usage_events_tenant_id_venue_id_capability_created_at_idx"
  ON "ai_usage_events"("tenant_id", "venue_id", "capability", "created_at");
