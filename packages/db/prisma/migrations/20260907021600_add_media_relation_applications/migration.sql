ALTER TABLE "venue_location_connections"
  ADD CONSTRAINT "venue_location_connections_scope_key" UNIQUE ("id", "tenant_id", "venue_id");

CREATE TABLE "media_relation_applications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "revision_id" UUID NOT NULL,
  "relation_id" VARCHAR(191) NOT NULL,
  "relation_review_request_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "connection_id" UUID NOT NULL,
  "input_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_relation_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_relation_applications_relation_present" CHECK (BTRIM("relation_id") <> ''),
  CONSTRAINT "media_relation_applications_actor_present" CHECK (BTRIM("actor_id") <> ''),
  CONSTRAINT "media_relation_applications_request_hash_shape" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_relation_applications_snapshot_object" CHECK (jsonb_typeof("input_snapshot") = 'object'),
  CONSTRAINT "media_relation_applications_snapshot_size" CHECK (OCTET_LENGTH("input_snapshot"::text) <= 262144),
  CONSTRAINT "media_relation_applications_request_key" UNIQUE ("tenant_id", "request_id"),
  CONSTRAINT "media_relation_applications_review_key" UNIQUE ("tenant_id", "venue_id", "relation_review_request_id"),
  CONSTRAINT "media_relation_applications_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_relation_applications_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues" ("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_relation_applications_revision_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id") REFERENCES "media_entity_resolution_revisions" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_relation_applications_connection_fkey" FOREIGN KEY ("connection_id", "tenant_id", "venue_id") REFERENCES "venue_location_connections" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "media_relation_applications_scope_created_idx"
  ON "media_relation_applications" ("tenant_id", "venue_id", "revision_id", "created_at");

CREATE FUNCTION pathfinder_guard_media_relation_application_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  locked_project_id TEXT;
  locked_source_generation UUID;
  locked_source_revision INTEGER;
  latest_revision INTEGER;
  project_tenant_id TEXT;
  project_venue_id TEXT;
  project_source_generation UUID;
  connection_active BOOLEAN;
BEGIN
  SELECT revision."project_id", revision."source_generation", revision."revision",
         project."tenant_id", project."venue_id", project."source_object_generation"
    INTO locked_project_id, locked_source_generation, locked_source_revision, project_tenant_id, project_venue_id, project_source_generation
    FROM "media_entity_resolution_revisions" revision
    JOIN "media_ingestion_projects" project
      ON project."id" = revision."project_id"
     AND project."tenant_id" = revision."tenant_id"
     AND project."venue_id" = revision."venue_id"
   WHERE revision."id" = NEW."revision_id"
     AND revision."tenant_id" = NEW."tenant_id"
     AND revision."venue_id" = NEW."venue_id"
   FOR UPDATE OF project;

  IF NOT FOUND OR project_tenant_id IS DISTINCT FROM NEW."tenant_id"
     OR project_venue_id IS DISTINCT FROM NEW."venue_id" THEN
    RAISE EXCEPTION 'Media relation application revision is outside the exact tenant and venue scope';
  END IF;
  IF project_source_generation IS NULL
     OR project_source_generation IS DISTINCT FROM locked_source_generation THEN
    RAISE EXCEPTION 'Media relation application revision is stale for the current project generation';
  END IF;

  SELECT MAX(revision."revision") INTO latest_revision
    FROM "media_entity_resolution_revisions" revision
   WHERE revision."tenant_id" = NEW."tenant_id"
     AND revision."venue_id" = NEW."venue_id"
     AND revision."project_id" = locked_project_id
     AND revision."source_generation" = locked_source_generation;
  IF locked_source_revision IS DISTINCT FROM latest_revision THEN
    RAISE EXCEPTION 'Media relation application requires the latest exact resolution revision';
  END IF;

  SELECT connection."is_active" INTO connection_active
    FROM "venue_location_connections" connection
   WHERE connection."id" = NEW."connection_id"
     AND connection."tenant_id" = NEW."tenant_id"
     AND connection."venue_id" = NEW."venue_id"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Media relation application connection is outside the exact tenant and venue scope';
  END IF;
  IF connection_active THEN
    RAISE EXCEPTION 'Media relation application may bind only an inactive canonical connection';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "media_relation_application_insert_guard"
BEFORE INSERT ON "media_relation_applications"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_media_relation_application_insert();

CREATE FUNCTION pathfinder_guard_media_relation_application_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Media relation application receipts are append-only';
END $$;

CREATE TRIGGER "media_relation_application_append_only_guard"
BEFORE UPDATE OR DELETE ON "media_relation_applications"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_media_relation_application_append_only();

CREATE TRIGGER "media_relation_application_no_truncate"
BEFORE TRUNCATE ON "media_relation_applications"
FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_media_relation_application_append_only();
