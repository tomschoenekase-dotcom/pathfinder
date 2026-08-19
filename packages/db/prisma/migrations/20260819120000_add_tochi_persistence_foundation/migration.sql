-- Additive persistence foundation for Venue Bot configuration and the private
-- client-assistant domain. Existing Venue tone fields remain authoritative
-- compatibility fields during the migration window.

CREATE TYPE "VenueBotPresentationMode" AS ENUM ('CLASSIC', 'CHARACTER');
CREATE TYPE "VenueBotPersonalityMode" AS ENUM ('PRESET', 'CUSTOM');
CREATE TYPE "PersonalityProfileStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CustomCharacterStatus" AS ENUM ('REQUESTED', 'GENERATING', 'REVIEW', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "ClientAssistantThreadStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "ClientAssistantTurnStatus" AS ENUM ('RESERVED', 'GENERATING', 'COMPLETED', 'FAILED');
CREATE TYPE "ClientAssistantHandoffConfirmationState" AS ENUM ('CONFIRMED');

CREATE TABLE "personality_profiles" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "tone" VARCHAR(80),
  "verbosity" INTEGER NOT NULL DEFAULT 3,
  "warmth" INTEGER NOT NULL DEFAULT 3,
  "humor" INTEGER NOT NULL DEFAULT 1,
  "formality" INTEGER NOT NULL DEFAULT 3,
  "custom_instruction" VARCHAR(2000),
  "status" "PersonalityProfileStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "personality_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personality_profiles_style_bounds" CHECK (
    "verbosity" BETWEEN 1 AND 5 AND "warmth" BETWEEN 1 AND 5
    AND "humor" BETWEEN 1 AND 5 AND "formality" BETWEEN 1 AND 5
  ),
  CONSTRAINT "personality_profiles_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "personality_profiles_id_tenant_id_key" ON "personality_profiles"("id", "tenant_id");
CREATE INDEX "personality_profiles_tenant_id_venue_id_status_updated_at_idx" ON "personality_profiles"("tenant_id", "venue_id", "status", "updated_at");

CREATE TABLE "custom_characters" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "status" "CustomCharacterStatus" NOT NULL DEFAULT 'REQUESTED',
  "asset_storage_reference" JSONB,
  "preview_storage_reference" JSONB,
  "capability_metadata" JSONB NOT NULL DEFAULT '{}',
  "fallback_behavior" JSONB NOT NULL DEFAULT '{}',
  "default_personality_profile_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_characters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "custom_characters_versions_positive" CHECK ("version" > 0 AND "revision" > 0)
);
CREATE UNIQUE INDEX "custom_characters_id_tenant_id_key" ON "custom_characters"("id", "tenant_id");
CREATE UNIQUE INDEX "custom_characters_id_tenant_id_venue_id_key" ON "custom_characters"("id", "tenant_id", "venue_id");
CREATE INDEX "custom_characters_tenant_id_venue_id_status_updated_at_idx" ON "custom_characters"("tenant_id", "venue_id", "status", "updated_at");

CREATE TABLE "venue_bot_configurations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "presentation_mode" "VenueBotPresentationMode" NOT NULL DEFAULT 'CLASSIC',
  "personality_mode" "VenueBotPersonalityMode" NOT NULL DEFAULT 'PRESET',
  "tone_preset" VARCHAR(40) NOT NULL DEFAULT 'friendly',
  "tone_preset_version" INTEGER NOT NULL DEFAULT 1,
  "personality_profile_id" TEXT,
  "character_key" VARCHAR(100),
  "custom_character_id" TEXT,
  "public_display_name" VARCHAR(80),
  "greeting" VARCHAR(500),
  "voice_profile_id" VARCHAR(191),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "venue_bot_configurations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_bot_configurations_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "venue_bot_configurations_tone_contract" CHECK (
    "tone_preset_version" = 1
    AND "tone_preset" IN ('friendly', 'concise', 'enthusiastic', 'informative')
  ),
  CONSTRAINT "venue_bot_configurations_personality_contract" CHECK (
    ("personality_mode" = 'PRESET' AND "personality_profile_id" IS NULL)
    OR ("personality_mode" = 'CUSTOM' AND "personality_profile_id" IS NOT NULL)
  ),
  CONSTRAINT "venue_bot_configurations_character_contract" CHECK (
    NOT ("character_key" IS NOT NULL AND "custom_character_id" IS NOT NULL)
    AND ("presentation_mode" = 'CLASSIC' OR "character_key" IS NOT NULL OR "custom_character_id" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "venue_bot_configurations_tenant_id_venue_id_key" ON "venue_bot_configurations"("tenant_id", "venue_id");
CREATE UNIQUE INDEX "venue_bot_configurations_venue_id_tenant_id_key" ON "venue_bot_configurations"("venue_id", "tenant_id");
CREATE UNIQUE INDEX "venue_bot_configurations_id_tenant_id_venue_id_key" ON "venue_bot_configurations"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_bot_configurations_tenant_id_presentation_mode_updated_at_idx" ON "venue_bot_configurations"("tenant_id", "presentation_mode", "updated_at");

CREATE TABLE "client_assistant_preferences" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "minimized" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_assistant_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_assistant_preferences_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "client_assistant_preferences_tenant_id_user_id_key" ON "client_assistant_preferences"("tenant_id", "user_id");
CREATE INDEX "client_assistant_preferences_tenant_id_enabled_updated_at_idx" ON "client_assistant_preferences"("tenant_id", "enabled", "updated_at");

CREATE TABLE "client_assistant_threads" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" "ClientAssistantThreadStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_assistant_threads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_assistant_threads_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "client_assistant_threads_status_contract" CHECK (
    ("status" = 'ACTIVE' AND "closed_at" IS NULL) OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "client_assistant_threads_id_tenant_id_key" ON "client_assistant_threads"("id", "tenant_id");
CREATE UNIQUE INDEX "client_assistant_threads_id_tenant_id_venue_id_key" ON "client_assistant_threads"("id", "tenant_id", "venue_id");
CREATE INDEX "client_assistant_threads_tenant_id_user_id_status_last_active_at_idx" ON "client_assistant_threads"("tenant_id", "user_id", "status", "last_active_at");
CREATE INDEX "client_assistant_threads_tenant_id_venue_id_status_last_active_at_idx" ON "client_assistant_threads"("tenant_id", "venue_id", "status", "last_active_at");

CREATE TABLE "client_assistant_turns" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "ClientAssistantTurnStatus" NOT NULL DEFAULT 'RESERVED',
  "behavior_version" VARCHAR(100) NOT NULL,
  "user_message" VARCHAR(10000) NOT NULL,
  "assistant_message" VARCHAR(20000),
  "question_category" VARCHAR(100),
  "safe_actions" JSONB NOT NULL DEFAULT '[]',
  "failure_code" VARCHAR(100),
  "generation_lease_id" UUID,
  "generation_lease_expires_at" TIMESTAMP(3),
  "generation_attempts" INTEGER NOT NULL DEFAULT 0,
  "provider_dispatched_at" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_assistant_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_assistant_turns_hash_format" CHECK ("operation_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "client_assistant_turns_sequence_positive" CHECK ("sequence" > 0 AND "revision" > 0 AND "generation_attempts" >= 0),
  CONSTRAINT "client_assistant_turns_terminal_contract" CHECK (
    ("status" IN ('RESERVED', 'GENERATING') AND "completed_at" IS NULL AND "assistant_message" IS NULL AND "failure_code" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "assistant_message" IS NOT NULL AND "failure_code" IS NULL)
    OR ("status" = 'FAILED' AND "completed_at" IS NOT NULL AND "failure_code" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "client_assistant_turns_id_tenant_id_venue_id_key" ON "client_assistant_turns"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "client_assistant_turns_tenant_id_operation_id_key" ON "client_assistant_turns"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "client_assistant_turns_generation_lease_id_key" ON "client_assistant_turns"("generation_lease_id");
CREATE UNIQUE INDEX "client_assistant_turns_thread_id_tenant_id_venue_id_sequence_key" ON "client_assistant_turns"("thread_id", "tenant_id", "venue_id", "sequence");
CREATE INDEX "client_assistant_turns_tenant_id_venue_id_thread_id_created_at_idx" ON "client_assistant_turns"("tenant_id", "venue_id", "thread_id", "created_at");
CREATE INDEX "client_assistant_turns_tenant_id_status_updated_at_idx" ON "client_assistant_turns"("tenant_id", "status", "updated_at");
CREATE INDEX "client_assistant_turns_tenant_id_status_generation_lease_expires_at_idx" ON "client_assistant_turns"("tenant_id", "status", "generation_lease_expires_at");

CREATE TABLE "client_assistant_support_handoffs" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "turn_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "summary_snapshot" JSONB NOT NULL,
  "confirmation_state" "ClientAssistantHandoffConfirmationState" NOT NULL DEFAULT 'CONFIRMED',
  "confirmed_by_user_id" TEXT NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_assistant_support_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_assistant_support_handoffs_hash_format" CHECK ("operation_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "client_assistant_support_handoffs_tenant_id_operation_id_key" ON "client_assistant_support_handoffs"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "client_assistant_support_handoffs_support_request_id_tenant_id_venue_id_key" ON "client_assistant_support_handoffs"("support_request_id", "tenant_id", "venue_id");
CREATE INDEX "client_assistant_support_handoffs_tenant_id_venue_id_turn_id_created_at_idx" ON "client_assistant_support_handoffs"("tenant_id", "venue_id", "turn_id", "created_at");

ALTER TABLE "ai_usage_events" ADD COLUMN "client_assistant_turn_id" TEXT;
CREATE INDEX "ai_usage_events_client_assistant_turn_id_idx" ON "ai_usage_events"("client_assistant_turn_id");

ALTER TABLE "personality_profiles" ADD CONSTRAINT "personality_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "personality_profiles" ADD CONSTRAINT "personality_profiles_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "custom_characters" ADD CONSTRAINT "custom_characters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "custom_characters" ADD CONSTRAINT "custom_characters_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "custom_characters" ADD CONSTRAINT "custom_characters_default_personality_scope_fkey" FOREIGN KEY ("default_personality_profile_id", "tenant_id") REFERENCES "personality_profiles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_bot_configurations" ADD CONSTRAINT "venue_bot_configurations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_bot_configurations" ADD CONSTRAINT "venue_bot_configurations_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "venue_bot_configurations" ADD CONSTRAINT "venue_bot_configurations_personality_scope_fkey" FOREIGN KEY ("personality_profile_id", "tenant_id") REFERENCES "personality_profiles"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_bot_configurations" ADD CONSTRAINT "venue_bot_configurations_custom_character_scope_fkey" FOREIGN KEY ("custom_character_id", "tenant_id", "venue_id") REFERENCES "custom_characters"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_preferences" ADD CONSTRAINT "client_assistant_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_preferences" ADD CONSTRAINT "client_assistant_preferences_membership_scope_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_threads" ADD CONSTRAINT "client_assistant_threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_threads" ADD CONSTRAINT "client_assistant_threads_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_threads" ADD CONSTRAINT "client_assistant_threads_membership_scope_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_turns" ADD CONSTRAINT "client_assistant_turns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_turns" ADD CONSTRAINT "client_assistant_turns_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_turns" ADD CONSTRAINT "client_assistant_turns_thread_scope_fkey" FOREIGN KEY ("thread_id", "tenant_id", "venue_id") REFERENCES "client_assistant_threads"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_support_handoffs" ADD CONSTRAINT "client_assistant_support_handoffs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_support_handoffs" ADD CONSTRAINT "client_assistant_support_handoffs_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_support_handoffs" ADD CONSTRAINT "client_assistant_support_handoffs_turn_scope_fkey" FOREIGN KEY ("turn_id", "tenant_id", "venue_id") REFERENCES "client_assistant_turns"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_support_handoffs" ADD CONSTRAINT "client_assistant_support_handoffs_request_scope_fkey" FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_assistant_support_handoffs" ADD CONSTRAINT "client_assistant_support_handoffs_confirmer_scope_fkey" FOREIGN KEY ("tenant_id", "confirmed_by_user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_client_assistant_turn_scope_fkey" FOREIGN KEY ("client_assistant_turn_id", "tenant_id", "venue_id") REFERENCES "client_assistant_turns"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Forward-safe backfill: every existing venue receives a Classic configuration
-- and its currently effective preset is preserved. Legacy Venue fields remain.
INSERT INTO "venue_bot_configurations" (
  "id", "tenant_id", "venue_id", "presentation_mode", "personality_mode",
  "tone_preset", "tone_preset_version", "revision", "created_by", "updated_by",
  "created_at", "updated_at"
)
SELECT
  'vbc_' || md5(v."id"),
  v."tenant_id",
  v."id",
  'CLASSIC'::"VenueBotPresentationMode",
  'PRESET'::"VenueBotPersonalityMode",
  CASE
    WHEN v."tone_preset_version" = 1 AND v."tone_preset" IN ('friendly', 'concise', 'enthusiastic', 'informative') THEN v."tone_preset"
    WHEN v."ai_tone" = 'PLAYFUL' THEN 'enthusiastic'
    WHEN v."ai_tone" = 'PROFESSIONAL' THEN 'informative'
    ELSE 'friendly'
  END,
  1,
  1,
  'system:tochi-foundation-migration',
  'system:tochi-foundation-migration',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "venues" v
ON CONFLICT ("tenant_id", "venue_id") DO NOTHING;
