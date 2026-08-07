CREATE TABLE "embedding_dispatches" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "entity_type" "EmbeddingWorkEntityType" NOT NULL,
  "entity_id" TEXT NOT NULL,
  "content_updated_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "embedding_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_dispatches_lease_state_check" CHECK (
    ("lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR
    ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "embedding_dispatches_entity_key"
  ON "embedding_dispatches"("tenant_id", "venue_id", "entity_type", "entity_id");
CREATE INDEX "embedding_dispatches_due_idx"
  ON "embedding_dispatches"("next_attempt_at", "lease_expires_at", "created_at");
CREATE INDEX "embedding_dispatches_tenant_id_venue_id_created_at_idx"
  ON "embedding_dispatches"("tenant_id", "venue_id", "created_at");

ALTER TABLE "embedding_dispatches"
  ADD CONSTRAINT "embedding_dispatches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "embedding_dispatches"
  ADD CONSTRAINT "embedding_dispatches_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION upsert_place_embedding_dispatch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM embedding_dispatches
    WHERE tenant_id = OLD.tenant_id
      AND venue_id = OLD.venue_id
      AND entity_type = 'PLACE'
      AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.venue_id IS DISTINCT FROM NEW.venue_id
    ) THEN
    DELETE FROM embedding_dispatches
    WHERE tenant_id = OLD.tenant_id
      AND venue_id = OLD.venue_id
      AND entity_type = 'PLACE'
      AND entity_id = OLD.id;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
    AND OLD.venue_id IS NOT DISTINCT FROM NEW.venue_id
    AND ROW(
    OLD.name, OLD.type, OLD.item_type, OLD.short_description,
    OLD.long_description, OLD.tags, OLD.area_name, OLD.hours, OLD.is_active
  ) IS NOT DISTINCT FROM ROW(
    NEW.name, NEW.type, NEW.item_type, NEW.short_description,
    NEW.long_description, NEW.tags, NEW.area_name, NEW.hours, NEW.is_active
  ) THEN
    -- Prisma advances updated_at for metadata-only edits. Carry any already
    -- pending content intent to that revision so the worker does not reject it
    -- as stale, but do not create fresh provider work for metadata alone.
    IF OLD.updated_at IS DISTINCT FROM NEW.updated_at THEN
      UPDATE embedding_dispatches
      SET content_updated_at = NEW.updated_at,
          attempts = 0,
          next_attempt_at = clock_timestamp(),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND venue_id = NEW.venue_id
        AND entity_type = 'PLACE'
        AND entity_id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO embedding_dispatches (
    id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
    attempts, next_attempt_at, lease_token, lease_expires_at, last_error,
    created_at, updated_at
  ) VALUES (
    'place:' || NEW.id, NEW.tenant_id, NEW.venue_id, 'PLACE', NEW.id, NEW.updated_at,
    0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO UPDATE SET
    content_updated_at = EXCLUDED.content_updated_at,
    attempts = 0,
    next_attempt_at = clock_timestamp(),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_knowledge_embedding_dispatch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM embedding_dispatches
    WHERE tenant_id = OLD.tenant_id
      AND venue_id = OLD.venue_id
      AND entity_type = 'KNOWLEDGE_ENTRY'
      AND entity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.venue_id IS DISTINCT FROM NEW.venue_id
    ) THEN
    DELETE FROM embedding_dispatches
    WHERE tenant_id = OLD.tenant_id
      AND venue_id = OLD.venue_id
      AND entity_type = 'KNOWLEDGE_ENTRY'
      AND entity_id = OLD.id;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
    AND OLD.venue_id IS NOT DISTINCT FROM NEW.venue_id
    AND ROW(
    OLD.title, OLD.category, OLD.content, OLD.is_enabled
  ) IS NOT DISTINCT FROM ROW(
    NEW.title, NEW.category, NEW.content, NEW.is_enabled
  ) THEN
    IF OLD.updated_at IS DISTINCT FROM NEW.updated_at THEN
      UPDATE embedding_dispatches
      SET content_updated_at = NEW.updated_at,
          attempts = 0,
          next_attempt_at = clock_timestamp(),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND venue_id = NEW.venue_id
        AND entity_type = 'KNOWLEDGE_ENTRY'
        AND entity_id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO embedding_dispatches (
    id, tenant_id, venue_id, entity_type, entity_id, content_updated_at,
    attempts, next_attempt_at, lease_token, lease_expires_at, last_error,
    created_at, updated_at
  ) VALUES (
    'knowledge:' || NEW.id, NEW.tenant_id, NEW.venue_id, 'KNOWLEDGE_ENTRY', NEW.id, NEW.updated_at,
    0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (tenant_id, venue_id, entity_type, entity_id) DO UPDATE SET
    content_updated_at = EXCLUDED.content_updated_at,
    attempts = 0,
    next_attempt_at = clock_timestamp(),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER places_embedding_dispatch_trigger
AFTER INSERT OR UPDATE OR DELETE ON places
FOR EACH ROW EXECUTE FUNCTION upsert_place_embedding_dispatch();

CREATE TRIGGER knowledge_embedding_dispatch_trigger
AFTER INSERT OR UPDATE OR DELETE ON venue_knowledge_entries
FOR EACH ROW EXECUTE FUNCTION upsert_knowledge_embedding_dispatch();
