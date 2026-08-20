ALTER TABLE "ai_usage_daily_rollups"
  ADD COLUMN "audio_input_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "audio_output_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cached_audio_input_tokens" INTEGER NOT NULL DEFAULT 0;
