ALTER TABLE "ai_usage_events"
  ADD COLUMN "usage_observation_status" VARCHAR(32);

ALTER TABLE "ai_usage_events"
  ADD CONSTRAINT "ai_usage_events_observation_status_check"
  CHECK (
    "usage_observation_status" IS NULL
    OR "usage_observation_status" IN ('OBSERVED', 'UNKNOWN', 'NOT_DISPATCHED')
  );

ALTER TABLE "ai_usage_daily_rollups"
  ADD COLUMN "observed_usage_request_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unknown_usage_request_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "not_dispatched_request_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "legacy_unclassified_request_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "observed_total_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "observed_estimated_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- Existing rollups predate observation classification. Preserve their recorded
-- totals while making their coverage explicitly legacy/unclassified.
UPDATE "ai_usage_daily_rollups"
SET "legacy_unclassified_request_count" = "request_count";
