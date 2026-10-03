BEGIN;

-- Voice usage comes from a visitor client, not provider-side observed billing.
-- Keep it classified separately; this migration does not rewrite historical usage.
ALTER TABLE "ai_usage_events"
  DROP CONSTRAINT "ai_usage_events_observation_status_check";
ALTER TABLE "ai_usage_events"
  ADD CONSTRAINT "ai_usage_events_observation_status_check"
  CHECK (
    "usage_observation_status" IS NULL
    OR "usage_observation_status" IN ('OBSERVED', 'UNKNOWN', 'NOT_DISPATCHED', 'CLIENT_REPORTED')
  );

COMMIT;
