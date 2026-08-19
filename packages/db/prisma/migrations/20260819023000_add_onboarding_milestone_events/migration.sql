CREATE TABLE "onboarding_milestone_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "event_version" INTEGER NOT NULL DEFAULT 1,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "identity_hash" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "actor_type" VARCHAR(32) NOT NULL,
  "actor_id" VARCHAR(191),
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(191) NOT NULL,
  "source_revision" VARCHAR(191),
  "category" VARCHAR(100),
  "duration_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onboarding_milestone_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_milestone_events_duration_check"
    CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  CONSTRAINT "onboarding_milestone_events_version_check" CHECK ("event_version" = 1),
  CONSTRAINT "onboarding_milestone_events_identity_hash_check"
    CHECK ("identity_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "onboarding_milestone_events_replay_key"
  ON "onboarding_milestone_events"("tenant_id", "venue_id", "event_type", "idempotency_key");
CREATE INDEX "onboarding_milestone_events_timeline_idx"
  ON "onboarding_milestone_events"("tenant_id", "venue_id", "occurred_at", "id");
CREATE INDEX "onboarding_milestone_events_rollup_idx"
  ON "onboarding_milestone_events"("tenant_id", "event_type", "occurred_at");

ALTER TABLE "onboarding_milestone_events"
  ADD CONSTRAINT "onboarding_milestone_events_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_milestone_events"
  ADD CONSTRAINT "onboarding_milestone_events_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "reject_onboarding_milestone_event_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'onboarding milestone events are append-only';
END;
$$;

CREATE TRIGGER "onboarding_milestone_events_update_delete_guard"
BEFORE UPDATE OR DELETE ON "onboarding_milestone_events"
FOR EACH ROW EXECUTE FUNCTION "reject_onboarding_milestone_event_mutation"();

CREATE TRIGGER "onboarding_milestone_events_truncate_guard"
BEFORE TRUNCATE ON "onboarding_milestone_events"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_onboarding_milestone_event_mutation"();
