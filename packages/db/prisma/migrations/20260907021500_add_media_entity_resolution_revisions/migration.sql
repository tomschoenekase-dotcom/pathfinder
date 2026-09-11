CREATE TABLE "media_entity_resolution_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_generation" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "evidence_snapshot_hash" CHAR(64) NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "state" JSONB NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_entity_resolution_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_entity_resolution_revisions_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "media_entity_resolution_revisions_request_hash_shape" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_entity_resolution_revisions_evidence_hash_shape" CHECK ("evidence_snapshot_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_entity_resolution_revisions_state_size" CHECK (OCTET_LENGTH("state"::text) <= 8388608),
  CONSTRAINT "media_entity_resolution_revisions_evidence_snapshot_size" CHECK (OCTET_LENGTH("evidence_snapshot"::text) <= 8388608),
  CONSTRAINT "media_entity_resolution_revisions_combined_payload_size" CHECK (OCTET_LENGTH("state"::text) + OCTET_LENGTH("evidence_snapshot"::text) <= 8388608),
  CONSTRAINT "media_entity_resolution_revisions_actor_present" CHECK (BTRIM("actor_id") <> ''),
  CONSTRAINT "media_entity_resolution_revisions_request_key" UNIQUE ("tenant_id", "request_id"),
  CONSTRAINT "media_entity_resolution_revisions_generation_revision_key" UNIQUE ("project_id", "tenant_id", "venue_id", "source_generation", "revision"),
  CONSTRAINT "media_entity_resolution_revisions_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "media_entity_resolution_revisions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_entity_resolution_revisions_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues" ("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_entity_resolution_revisions_project_fkey" FOREIGN KEY ("project_id", "tenant_id", "venue_id") REFERENCES "media_ingestion_projects" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "media_entity_resolution_revisions_scope_created_idx"
  ON "media_entity_resolution_revisions" ("tenant_id", "venue_id", "project_id", "source_generation", "created_at");

CREATE FUNCTION pathfinder_guard_media_entity_resolution_revision_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  locked_project "media_ingestion_projects"%ROWTYPE;
  expected_revision INTEGER;
  prior_state JSONB;
  prior_evidence_snapshot JSONB;
  prior_evidence_snapshot_hash CHAR(64);
BEGIN
  SELECT * INTO locked_project
    FROM "media_ingestion_projects"
   WHERE "id" = NEW."project_id"
     AND "tenant_id" = NEW."tenant_id"
     AND "venue_id" = NEW."venue_id"
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Media resolution project is outside the exact tenant and venue scope';
  END IF;
  IF locked_project."status"::text <> 'READY_FOR_REVIEW' OR locked_project."stage" <> 'review' THEN
    RAISE EXCEPTION 'Media resolution revisions require a project ready for review';
  END IF;
  IF locked_project."source_object_generation" IS NULL
     OR locked_project."source_object_generation" IS DISTINCT FROM NEW."source_generation" THEN
    RAISE EXCEPTION 'Media resolution source generation is stale or missing';
  END IF;
  IF locked_project."upload_attempt_id" IS NULL THEN
    RAISE EXCEPTION 'Media resolution upload attempt is missing';
  END IF;
  IF jsonb_typeof(NEW."state") IS DISTINCT FROM 'object'
     OR NEW."state"->'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(NEW."state"->'scope') IS DISTINCT FROM 'object'
     OR NEW."state"->'scope'->>'tenantId' IS DISTINCT FROM NEW."tenant_id"
     OR NEW."state"->'scope'->>'projectId' IS DISTINCT FROM NEW."project_id"
     OR NEW."state"->'scope'->>'uploadAttemptId' IS DISTINCT FROM locked_project."upload_attempt_id"::text THEN
    RAISE EXCEPTION 'Media resolution state scope does not match the locked project generation';
  END IF;
  IF jsonb_typeof(NEW."evidence_snapshot") IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW."evidence_snapshot"->'scope') IS DISTINCT FROM 'object'
     OR NEW."evidence_snapshot"->'scope'->>'tenantId' IS DISTINCT FROM NEW."tenant_id"
     OR NEW."evidence_snapshot"->'scope'->>'projectId' IS DISTINCT FROM NEW."project_id"
     OR NEW."evidence_snapshot"->'scope'->>'uploadAttemptId' IS DISTINCT FROM locked_project."upload_attempt_id"::text
     OR NEW."evidence_snapshot"->>'sourceGeneration' IS DISTINCT FROM NEW."source_generation"::text
     OR jsonb_typeof(NEW."evidence_snapshot"->'candidates') IS DISTINCT FROM 'array'
     OR NEW."evidence_snapshot"->'candidates' IS DISTINCT FROM NEW."state"->'candidates'
     OR jsonb_typeof(NEW."evidence_snapshot"->'evidence') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Media resolution evidence snapshot does not match the locked project generation';
  END IF;

  SELECT COALESCE(MAX(existing."revision"), 0) + 1 INTO expected_revision
    FROM "media_entity_resolution_revisions" existing
   WHERE existing."tenant_id" = NEW."tenant_id"
     AND existing."venue_id" = NEW."venue_id"
     AND existing."project_id" = NEW."project_id"
     AND existing."source_generation" = NEW."source_generation";
  IF NEW."revision" IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Media resolution revision must be the next exact generation revision';
  END IF;
  IF jsonb_typeof(NEW."state"->'candidates') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW."state"->'decisions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW."state"->'decisions') IS DISTINCT FROM NEW."revision" - 1 THEN
    RAISE EXCEPTION 'Media resolution state must contain exactly one decision per appended revision';
  END IF;
  IF NEW."revision" = 1 THEN
    IF jsonb_array_length(NEW."state"->'decisions') <> 0 THEN
      RAISE EXCEPTION 'The initial media resolution revision must have no decisions';
    END IF;
  ELSE
    SELECT existing."state", existing."evidence_snapshot", existing."evidence_snapshot_hash"
      INTO prior_state, prior_evidence_snapshot, prior_evidence_snapshot_hash
      FROM "media_entity_resolution_revisions" existing
     WHERE existing."tenant_id" = NEW."tenant_id"
       AND existing."venue_id" = NEW."venue_id"
       AND existing."project_id" = NEW."project_id"
       AND existing."source_generation" = NEW."source_generation"
       AND existing."revision" = NEW."revision" - 1;
    IF NOT FOUND
       OR NEW."state"->'scope' IS DISTINCT FROM prior_state->'scope'
       OR NEW."state"->'candidates' IS DISTINCT FROM prior_state->'candidates'
       OR ((NEW."state"->'decisions') - (NEW."revision" - 2)) IS DISTINCT FROM prior_state->'decisions'
       OR NEW."evidence_snapshot" IS DISTINCT FROM prior_evidence_snapshot
       OR NEW."evidence_snapshot_hash" IS DISTINCT FROM prior_evidence_snapshot_hash
       OR (NEW."state"->'decisions')->(NEW."revision" - 2)->>'requestId' IS DISTINCT FROM NEW."request_id"::text
       OR (NEW."state"->'decisions')->(NEW."revision" - 2)->>'reviewerId' IS DISTINCT FROM NEW."actor_id" THEN
      RAISE EXCEPTION 'Media resolution revision must append one actor-bound decision to immutable evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "media_entity_resolution_revision_insert_guard"
BEFORE INSERT ON "media_entity_resolution_revisions"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_media_entity_resolution_revision_insert();

CREATE FUNCTION pathfinder_guard_media_entity_resolution_revision_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Media entity resolution revisions are append-only';
END $$;

CREATE TRIGGER "media_entity_resolution_revision_append_only_guard"
BEFORE UPDATE OR DELETE ON "media_entity_resolution_revisions"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_media_entity_resolution_revision_append_only();

CREATE TRIGGER "media_entity_resolution_revision_no_truncate"
BEFORE TRUNCATE ON "media_entity_resolution_revisions"
FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_media_entity_resolution_revision_append_only();
