-- Additive, forward-only AI workload configuration control plane.
-- This migration stores configuration metadata only. It contains no provider
-- credentials and does not enable any override by default.

BEGIN;

CREATE TYPE "AiConfigurationScopeLevel" AS ENUM ('CLIENT', 'VENUE');
CREATE TYPE "AiConfigurationHistoryAction" AS ENUM ('CREATED', 'UPDATED', 'RESET');

CREATE TABLE "ai_workload_configuration_overrides" (
  "id" TEXT NOT NULL,
  "workload_id" VARCHAR(100) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "primary_model_key" VARCHAR(100), "primary_model_key_set" BOOLEAN NOT NULL DEFAULT false,
  "fallback_enabled" BOOLEAN, "fallback_enabled_set" BOOLEAN NOT NULL DEFAULT false,
  "fallback_model_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "fallback_model_keys_set" BOOLEAN NOT NULL DEFAULT false,
  "timeout_ms" INTEGER, "timeout_ms_set" BOOLEAN NOT NULL DEFAULT false,
  "max_attempts" INTEGER, "max_attempts_set" BOOLEAN NOT NULL DEFAULT false,
  "max_output_tokens" INTEGER, "max_output_tokens_set" BOOLEAN NOT NULL DEFAULT false,
  "request_budget_ceiling_e8_usd" VARCHAR(40), "request_budget_ceiling_e8_usd_set" BOOLEAN NOT NULL DEFAULT false,
  "unsafe_changes_enabled" BOOLEAN NOT NULL DEFAULT false,
  "is_tombstone" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(500) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL, "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_workload_configuration_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_workload_configuration_overrides_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ai_workload_configuration_overrides_budget_check" CHECK ("request_budget_ceiling_e8_usd" IS NULL OR "request_budget_ceiling_e8_usd" ~ '^[0-9]+$'),
  CONSTRAINT "ai_workload_configuration_overrides_primary_consistency_check" CHECK ("primary_model_key_set" = ("primary_model_key" IS NOT NULL)),
  CONSTRAINT "ai_workload_configuration_overrides_fallback_enabled_consistency_check" CHECK ("fallback_enabled_set" = ("fallback_enabled" IS NOT NULL)),
  CONSTRAINT "ai_workload_configuration_overrides_fallback_models_consistency_check" CHECK ("fallback_model_keys_set" OR cardinality("fallback_model_keys") = 0),
  CONSTRAINT "ai_workload_configuration_overrides_fallback_models_bound_check" CHECK (cardinality("fallback_model_keys") <= 3),
  CONSTRAINT "ai_workload_configuration_overrides_timeout_consistency_check" CHECK ((NOT "timeout_ms_set" AND "timeout_ms" IS NULL) OR ("timeout_ms_set" AND "timeout_ms" BETWEEN 100 AND 120000)),
  CONSTRAINT "ai_workload_configuration_overrides_attempts_consistency_check" CHECK ((NOT "max_attempts_set" AND "max_attempts" IS NULL) OR ("max_attempts_set" AND "max_attempts" BETWEEN 1 AND 5)),
  CONSTRAINT "ai_workload_configuration_overrides_output_consistency_check" CHECK ((NOT "max_output_tokens_set" AND "max_output_tokens" IS NULL) OR ("max_output_tokens_set" AND ("max_output_tokens" IS NULL OR "max_output_tokens" BETWEEN 1 AND 32000))),
  CONSTRAINT "ai_workload_configuration_overrides_budget_consistency_check" CHECK ((NOT "request_budget_ceiling_e8_usd_set" AND "request_budget_ceiling_e8_usd" IS NULL) OR "request_budget_ceiling_e8_usd_set"),
  CONSTRAINT "ai_workload_configuration_overrides_tombstone_check" CHECK (NOT "is_tombstone" OR (NOT "enabled" AND NOT "unsafe_changes_enabled" AND NOT "primary_model_key_set" AND NOT "fallback_enabled_set" AND NOT "fallback_model_keys_set" AND NOT "timeout_ms_set" AND NOT "max_attempts_set" AND NOT "max_output_tokens_set" AND NOT "request_budget_ceiling_e8_usd_set"))
);
CREATE UNIQUE INDEX "ai_workload_configuration_overrides_workload_id_key" ON "ai_workload_configuration_overrides"("workload_id");
CREATE INDEX "ai_workload_configuration_overrides_enabled_is_tombstone_idx" ON "ai_workload_configuration_overrides"("enabled", "is_tombstone");

CREATE TABLE "ai_workload_configuration_history" (
  "id" TEXT NOT NULL, "override_id" TEXT NOT NULL, "workload_id" VARCHAR(100) NOT NULL,
  "revision" INTEGER NOT NULL, "action" "AiConfigurationHistoryAction" NOT NULL,
  "snapshot" JSONB NOT NULL, "actor_id" VARCHAR(191) NOT NULL,
  "actor_role" VARCHAR(64) NOT NULL, "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_workload_configuration_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_workload_configuration_history_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "ai_workload_configuration_history_override_id_revision_key" ON "ai_workload_configuration_history"("override_id", "revision");
CREATE INDEX "ai_workload_configuration_history_workload_id_created_at_idx" ON "ai_workload_configuration_history"("workload_id", "created_at");

CREATE TABLE "ai_scoped_workload_configuration_overrides" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT,
  "venue_scope_key" VARCHAR(191) NOT NULL, "scope_level" "AiConfigurationScopeLevel" NOT NULL,
  "workload_id" VARCHAR(100) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "primary_model_key" VARCHAR(100), "primary_model_key_set" BOOLEAN NOT NULL DEFAULT false,
  "fallback_enabled" BOOLEAN, "fallback_enabled_set" BOOLEAN NOT NULL DEFAULT false,
  "fallback_model_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "fallback_model_keys_set" BOOLEAN NOT NULL DEFAULT false,
  "timeout_ms" INTEGER, "timeout_ms_set" BOOLEAN NOT NULL DEFAULT false,
  "max_attempts" INTEGER, "max_attempts_set" BOOLEAN NOT NULL DEFAULT false,
  "max_output_tokens" INTEGER, "max_output_tokens_set" BOOLEAN NOT NULL DEFAULT false,
  "request_budget_ceiling_e8_usd" VARCHAR(40), "request_budget_ceiling_e8_usd_set" BOOLEAN NOT NULL DEFAULT false,
  "unsafe_changes_enabled" BOOLEAN NOT NULL DEFAULT false,
  "is_tombstone" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(500) NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL, "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_scoped_workload_configuration_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_budget_check" CHECK ("request_budget_ceiling_e8_usd" IS NULL OR "request_budget_ceiling_e8_usd" ~ '^[0-9]+$'),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_primary_consistency_check" CHECK ("primary_model_key_set" = ("primary_model_key" IS NOT NULL)),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_fallback_enabled_consistency_check" CHECK ("fallback_enabled_set" = ("fallback_enabled" IS NOT NULL)),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_fallback_models_consistency_check" CHECK ("fallback_model_keys_set" OR cardinality("fallback_model_keys") = 0),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_fallback_models_bound_check" CHECK (cardinality("fallback_model_keys") <= 3),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_timeout_consistency_check" CHECK ((NOT "timeout_ms_set" AND "timeout_ms" IS NULL) OR ("timeout_ms_set" AND "timeout_ms" BETWEEN 100 AND 120000)),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_attempts_consistency_check" CHECK ((NOT "max_attempts_set" AND "max_attempts" IS NULL) OR ("max_attempts_set" AND "max_attempts" BETWEEN 1 AND 5)),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_output_consistency_check" CHECK ((NOT "max_output_tokens_set" AND "max_output_tokens" IS NULL) OR ("max_output_tokens_set" AND ("max_output_tokens" IS NULL OR "max_output_tokens" BETWEEN 1 AND 32000))),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_budget_consistency_check" CHECK ((NOT "request_budget_ceiling_e8_usd_set" AND "request_budget_ceiling_e8_usd" IS NULL) OR "request_budget_ceiling_e8_usd_set"),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_tombstone_check" CHECK (NOT "is_tombstone" OR (NOT "enabled" AND NOT "unsafe_changes_enabled" AND NOT "primary_model_key_set" AND NOT "fallback_enabled_set" AND NOT "fallback_model_keys_set" AND NOT "timeout_ms_set" AND NOT "max_attempts_set" AND NOT "max_output_tokens_set" AND NOT "request_budget_ceiling_e8_usd_set")),
  CONSTRAINT "ai_scoped_workload_configuration_overrides_scope_check" CHECK (
    ("scope_level" = 'CLIENT' AND "venue_id" IS NULL AND "venue_scope_key" = '__client__') OR
    ("scope_level" = 'VENUE' AND "venue_id" IS NOT NULL AND "venue_scope_key" = "venue_id")
  )
);
CREATE UNIQUE INDEX "ai_scoped_workload_configuration_overrides_tenant_id_venue_scope_key_workload_id_key" ON "ai_scoped_workload_configuration_overrides"("tenant_id", "venue_scope_key", "workload_id");
CREATE UNIQUE INDEX "ai_scoped_workload_configuration_overrides_id_tenant_id_key" ON "ai_scoped_workload_configuration_overrides"("id", "tenant_id");
CREATE INDEX "ai_scoped_workload_configuration_overrides_tenant_id_scope_level_enabled_is_tombstone_idx" ON "ai_scoped_workload_configuration_overrides"("tenant_id", "scope_level", "enabled", "is_tombstone");
CREATE INDEX "ai_scoped_workload_configuration_overrides_tenant_id_venue_id_idx" ON "ai_scoped_workload_configuration_overrides"("tenant_id", "venue_id");

CREATE TABLE "ai_scoped_workload_configuration_history" (
  "id" TEXT NOT NULL, "override_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT, "scope_level" "AiConfigurationScopeLevel" NOT NULL,
  "workload_id" VARCHAR(100) NOT NULL, "revision" INTEGER NOT NULL,
  "action" "AiConfigurationHistoryAction" NOT NULL, "snapshot" JSONB NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL, "actor_role" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_scoped_workload_configuration_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_scoped_workload_configuration_history_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "ai_scoped_workload_configuration_history_override_id_revision_key" ON "ai_scoped_workload_configuration_history"("override_id", "revision");
CREATE INDEX "ai_scoped_workload_configuration_history_tenant_id_venue_id_workload_id_created_at_idx" ON "ai_scoped_workload_configuration_history"("tenant_id", "venue_id", "workload_id", "created_at");

ALTER TABLE "ai_workload_configuration_history" ADD CONSTRAINT "ai_workload_configuration_history_override_id_fkey" FOREIGN KEY ("override_id") REFERENCES "ai_workload_configuration_overrides"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_scoped_workload_configuration_overrides" ADD CONSTRAINT "ai_scoped_workload_configuration_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_scoped_workload_configuration_overrides" ADD CONSTRAINT "ai_scoped_workload_configuration_overrides_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_scoped_workload_configuration_history" ADD CONSTRAINT "ai_scoped_workload_configuration_history_override_id_tenant_id_fkey" FOREIGN KEY ("override_id", "tenant_id") REFERENCES "ai_scoped_workload_configuration_overrides"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_scoped_workload_configuration_history" ADD CONSTRAINT "ai_scoped_workload_configuration_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_ai_workload_configuration_history_identity"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ai_workload_configuration_overrides" current_override
    WHERE current_override."id" = NEW."override_id"
      AND current_override."workload_id" = NEW."workload_id"
  ) THEN
    RAISE EXCEPTION 'AI workload configuration history identity does not match its override';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_workload_configuration_history_identity"
BEFORE INSERT ON "ai_workload_configuration_history"
FOR EACH ROW EXECUTE FUNCTION "enforce_ai_workload_configuration_history_identity"();

CREATE FUNCTION "enforce_ai_scoped_configuration_history_identity"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ai_scoped_workload_configuration_overrides" current_override
    WHERE current_override."id" = NEW."override_id"
      AND current_override."tenant_id" = NEW."tenant_id"
      AND current_override."venue_id" IS NOT DISTINCT FROM NEW."venue_id"
      AND current_override."scope_level" = NEW."scope_level"
      AND current_override."workload_id" = NEW."workload_id"
  ) THEN
    RAISE EXCEPTION 'AI scoped configuration history identity does not match its override';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_scoped_workload_configuration_history_identity"
BEFORE INSERT ON "ai_scoped_workload_configuration_history"
FOR EACH ROW EXECUTE FUNCTION "enforce_ai_scoped_configuration_history_identity"();

CREATE FUNCTION "prevent_ai_configuration_history_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI configuration history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ai_workload_configuration_history_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "ai_workload_configuration_history"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ai_configuration_history_mutation"();

CREATE TRIGGER "ai_scoped_workload_configuration_history_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "ai_scoped_workload_configuration_history"
FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ai_configuration_history_mutation"();

COMMIT;
