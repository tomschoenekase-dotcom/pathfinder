-- Additive indexes for the bounded, platform-wide one-hour operations performance projection.
-- No payload, provider-request identity, or customer-facing state is changed.
CREATE INDEX "job_records_completed_at_id_idx"
ON "job_records"("completed_at", "id");

CREATE INDEX "ai_usage_events_created_at_id_idx"
ON "ai_usage_events"("created_at", "id");
