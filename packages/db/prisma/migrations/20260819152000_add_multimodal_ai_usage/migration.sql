ALTER TABLE "ai_usage_events"
  ADD COLUMN "request_type" VARCHAR(100),
  ADD COLUMN "provider_request_id" VARCHAR(191),
  ADD COLUMN "audio_input_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "audio_output_tokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ai_usage_events" ADD COLUMN "cached_audio_input_tokens" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "ai_usage_events_provider_request_key"
  ON "ai_usage_events"("tenant_id", "venue_id", "provider", "provider_request_id");
