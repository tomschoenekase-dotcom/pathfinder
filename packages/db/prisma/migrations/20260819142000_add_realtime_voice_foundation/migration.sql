CREATE TYPE "VoiceSessionStatus" AS ENUM ('AUTHORIZING', 'READY', 'ACTIVE', 'ENDED', 'FAILED', 'EXPIRED');
CREATE TYPE "VoiceTranscriptSpeaker" AS ENUM ('VISITOR', 'ASSISTANT');

CREATE TABLE "voice_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "visitor_session_id" TEXT NOT NULL,
    "status" "VoiceSessionStatus" NOT NULL DEFAULT 'AUTHORIZING',
    "provider" VARCHAR(32) NOT NULL,
    "model" VARCHAR(191) NOT NULL,
    "capability" VARCHAR(64) NOT NULL,
    "tier" VARCHAR(32) NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "voice" VARCHAR(80) NOT NULL,
    "entitlement_snapshot" JSONB NOT NULL,
    "bot_configuration_snapshot" JSONB NOT NULL,
    "provider_session_id" VARCHAR(191),
    "client_secret_expires_at" TIMESTAMP(3),
    "max_duration_seconds" INTEGER NOT NULL,
    "connected_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "fallback_to_text" BOOLEAN NOT NULL DEFAULT false,
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_sessions_max_duration_check" CHECK ("max_duration_seconds" BETWEEN 30 AND 3600),
    CONSTRAINT "voice_sessions_duration_check" CHECK ("duration_seconds" BETWEEN 0 AND "max_duration_seconds")
);

CREATE TABLE "voice_transcript_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "voice_session_id" UUID NOT NULL,
    "provider_event_id" VARCHAR(191) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" "VoiceTranscriptSpeaker" NOT NULL,
    "text" VARCHAR(8000) NOT NULL,
    "language" VARCHAR(35),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_transcript_segments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voice_transcript_segments_sequence_check" CHECK ("sequence" >= 0),
    CONSTRAINT "voice_transcript_segments_text_check" CHECK (length(btrim("text")) > 0)
);

CREATE UNIQUE INDEX "voice_sessions_id_tenant_id_venue_id_key" ON "voice_sessions"("id", "tenant_id", "venue_id");
CREATE INDEX "voice_sessions_tenant_venue_status_created_idx" ON "voice_sessions"("tenant_id", "venue_id", "status", "created_at");
CREATE INDEX "voice_sessions_tenant_venue_created_idx" ON "voice_sessions"("tenant_id", "venue_id", "created_at");
CREATE INDEX "voice_sessions_visitor_session_created_idx" ON "voice_sessions"("visitor_session_id", "created_at");
CREATE UNIQUE INDEX "voice_transcript_segments_event_key" ON "voice_transcript_segments"("tenant_id", "venue_id", "voice_session_id", "provider_event_id");
CREATE UNIQUE INDEX "voice_transcript_segments_sequence_key" ON "voice_transcript_segments"("tenant_id", "venue_id", "voice_session_id", "sequence");
CREATE INDEX "voice_transcript_segments_scope_created_idx" ON "voice_transcript_segments"("tenant_id", "venue_id", "voice_session_id", "created_at");

ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_visitor_session_scope_fkey" FOREIGN KEY ("visitor_session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "voice_transcript_segments" ADD CONSTRAINT "voice_transcript_segments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "voice_transcript_segments" ADD CONSTRAINT "voice_transcript_segments_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "voice_transcript_segments" ADD CONSTRAINT "voice_transcript_segments_voice_session_scope_fkey" FOREIGN KEY ("voice_session_id", "tenant_id", "venue_id") REFERENCES "voice_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
