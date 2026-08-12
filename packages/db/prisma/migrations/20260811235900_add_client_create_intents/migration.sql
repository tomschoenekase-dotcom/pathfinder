BEGIN;

CREATE TYPE "ClientCreateIntentStatus" AS ENUM (
  'RESERVED',
  'PROVIDER_STARTED',
  'PROVIDER_CONFIRMED',
  'COMPLETED'
);

CREATE TABLE "client_create_intents" (
  "id" TEXT NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "actor_id" TEXT NOT NULL,
  "local_slug" TEXT,
  "status" "ClientCreateIntentStatus" NOT NULL DEFAULT 'RESERVED',
  "provider_organization_id" TEXT,
  "completed_tenant_id" TEXT,
  "completed_venue_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_create_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_create_intents_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "client_create_intents_lifecycle_fields_check" CHECK (
    ("status" = 'RESERVED' AND "local_slug" IS NULL
      AND "provider_organization_id" IS NULL AND "completed_tenant_id" IS NULL
      AND "completed_venue_id" IS NULL)
    OR
    ("status" = 'PROVIDER_STARTED' AND "local_slug" IS NOT NULL
      AND "provider_organization_id" IS NULL AND "completed_tenant_id" IS NULL
      AND "completed_venue_id" IS NULL)
    OR
    ("status" = 'PROVIDER_CONFIRMED' AND "local_slug" IS NOT NULL
      AND "provider_organization_id" IS NOT NULL AND "completed_tenant_id" IS NULL
      AND "completed_venue_id" IS NULL)
    OR
    ("status" = 'COMPLETED' AND "local_slug" IS NOT NULL
      AND "provider_organization_id" IS NOT NULL AND "completed_tenant_id" IS NOT NULL
      AND "completed_venue_id" IS NOT NULL
      AND "completed_tenant_id" = "provider_organization_id")
  )
);

CREATE TABLE "client_create_intent_events" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "status" "ClientCreateIntentStatus" NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_create_intent_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_create_intents_request_id_key"
  ON "client_create_intents"("request_id");
CREATE UNIQUE INDEX "client_create_intents_provider_organization_id_key"
  ON "client_create_intents"("provider_organization_id");
CREATE UNIQUE INDEX "client_create_intents_completed_tenant_id_key"
  ON "client_create_intents"("completed_tenant_id");
CREATE INDEX "client_create_intents_status_updated_at_idx"
  ON "client_create_intents"("status", "updated_at");
CREATE INDEX "client_create_intent_events_intent_id_created_at_idx"
  ON "client_create_intent_events"("intent_id", "created_at");

ALTER TABLE "client_create_intent_events"
  ADD CONSTRAINT "client_create_intent_events_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "client_create_intents"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_client_create_intent_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."request_id" IS DISTINCT FROM OLD."request_id"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."actor_id" IS DISTINCT FROM OLD."actor_id"
    OR (OLD."local_slug" IS NOT NULL AND NEW."local_slug" IS DISTINCT FROM OLD."local_slug")
    OR (OLD."provider_organization_id" IS NOT NULL
      AND NEW."provider_organization_id" IS DISTINCT FROM OLD."provider_organization_id")
    OR (OLD."completed_tenant_id" IS NOT NULL
      AND NEW."completed_tenant_id" IS DISTINCT FROM OLD."completed_tenant_id")
    OR (OLD."completed_venue_id" IS NOT NULL
      AND NEW."completed_venue_id" IS DISTINCT FROM OLD."completed_venue_id") THEN
    RAISE EXCEPTION 'client create intent identity and claims are immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'RESERVED' AND NEW."status" = 'PROVIDER_STARTED')
    OR (OLD."status" = 'PROVIDER_STARTED' AND NEW."status" = 'PROVIDER_CONFIRMED')
    OR (OLD."status" = 'PROVIDER_CONFIRMED' AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'invalid client create intent transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_create_intents_state_machine
BEFORE UPDATE ON "client_create_intents"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_client_create_intent_transition();

CREATE FUNCTION pathfinder_reject_client_create_intent_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'client create intent events are append-only';
END;
$$;

CREATE TRIGGER client_create_intent_events_append_only_update
BEFORE UPDATE ON "client_create_intent_events"
FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_client_create_intent_event_mutation();

CREATE TRIGGER client_create_intent_events_append_only_delete
BEFORE DELETE ON "client_create_intent_events"
FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_client_create_intent_event_mutation();

CREATE TRIGGER client_create_intent_events_append_only_truncate
BEFORE TRUNCATE ON "client_create_intent_events"
FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_client_create_intent_event_mutation();

COMMIT;
