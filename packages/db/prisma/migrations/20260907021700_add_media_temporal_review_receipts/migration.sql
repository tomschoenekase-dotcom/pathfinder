CREATE TABLE "media_temporal_review_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "source_generation" UUID NOT NULL,
  "upload_attempt_id" UUID NOT NULL, "request_id" UUID NOT NULL, "request_hash" CHAR(64) NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL, "snapshot" JSONB NOT NULL, "actor_id" VARCHAR(191) NOT NULL,
  "evaluated_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_temporal_review_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_temporal_review_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_review_receipts_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_review_receipts_project_fkey" FOREIGN KEY ("project_id", "tenant_id", "venue_id") REFERENCES "media_ingestion_projects"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_review_receipts_hashes_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$' AND "snapshot_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_temporal_review_receipts_actor_check" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "media_temporal_review_receipts_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object' AND octet_length("snapshot"::text) <= 2097152)
);
CREATE UNIQUE INDEX "media_temporal_review_receipts_request_key" ON "media_temporal_review_receipts"("tenant_id", "request_id");
CREATE UNIQUE INDEX "media_temporal_review_receipts_scope_key" ON "media_temporal_review_receipts"("id", "tenant_id", "venue_id");
CREATE INDEX "media_temporal_review_receipts_scope_created_idx" ON "media_temporal_review_receipts"("tenant_id", "venue_id", "project_id", "source_generation", "created_at");

CREATE TABLE "media_temporal_operational_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "review_receipt_id" UUID NOT NULL, "claim_id" VARCHAR(191) NOT NULL, "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL, "operational_update_id" TEXT NOT NULL, "actor_id" VARCHAR(191) NOT NULL,
  "input_snapshot" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_temporal_operational_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_temporal_operational_handoffs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_operational_handoffs_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_operational_handoffs_review_fkey" FOREIGN KEY ("review_receipt_id", "tenant_id", "venue_id") REFERENCES "media_temporal_review_receipts"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_operational_handoffs_update_fkey" FOREIGN KEY ("operational_update_id", "tenant_id", "venue_id") REFERENCES "operational_updates"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_temporal_operational_handoffs_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_temporal_operational_handoffs_text_check" CHECK (length(btrim("actor_id")) > 0 AND length(btrim("claim_id")) > 0),
  CONSTRAINT "media_temporal_operational_handoffs_snapshot_check" CHECK (jsonb_typeof("input_snapshot") = 'object' AND octet_length("input_snapshot"::text) <= 262144)
);
CREATE UNIQUE INDEX "media_temporal_handoffs_update_scope_key" ON "media_temporal_operational_handoffs"("operational_update_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "media_temporal_operational_handoffs_request_key" ON "media_temporal_operational_handoffs"("tenant_id", "request_id");
CREATE UNIQUE INDEX "media_temporal_operational_handoffs_claim_key" ON "media_temporal_operational_handoffs"("tenant_id", "venue_id", "review_receipt_id", "claim_id");
CREATE INDEX "media_temporal_operational_handoffs_scope_created_idx" ON "media_temporal_operational_handoffs"("tenant_id", "venue_id", "created_at");

CREATE FUNCTION guard_media_temporal_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_row media_ingestion_projects%ROWTYPE;
BEGIN
  SELECT * INTO project_row FROM media_ingestion_projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id FOR UPDATE;
  IF NOT FOUND OR project_row.status <> 'READY_FOR_REVIEW' OR project_row.stage <> 'review'
    OR project_row.source_object_generation IS DISTINCT FROM NEW.source_generation
    OR project_row.upload_attempt_id IS DISTINCT FROM NEW.upload_attempt_id THEN
    RAISE EXCEPTION 'temporal review requires exact current review project generation';
  END IF;
  IF NEW.snapshot->>'kind' IS DISTINCT FROM 'MEDIA_TEMPORAL_REVIEW' OR NEW.snapshot->>'version' IS DISTINCT FROM '1'
    OR NEW.snapshot->>'tenantId' IS DISTINCT FROM NEW.tenant_id
    OR NEW.snapshot->>'venueId' IS DISTINCT FROM NEW.venue_id
    OR NEW.snapshot->>'projectId' IS DISTINCT FROM NEW.project_id
    OR NEW.snapshot->>'sourceGeneration' IS DISTINCT FROM NEW.source_generation::text
    OR NEW.snapshot->>'uploadAttemptId' IS DISTINCT FROM NEW.upload_attempt_id::text
    OR NEW.snapshot->>'requestId' IS DISTINCT FROM NEW.request_id::text
    OR NEW.snapshot->>'reviewedBy' IS DISTINCT FROM NEW.actor_id
    OR NEW.snapshot->>'reviewedUpdatedAt' IS DISTINCT FROM to_char(project_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR NEW.snapshot#>>'{temporalReview,evaluatedAt}' IS DISTINCT FROM to_char(NEW.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR jsonb_typeof(NEW.snapshot#>'{temporalReview,claims}') IS DISTINCT FROM 'array'
    OR COALESCE(jsonb_array_length(NEW.snapshot#>'{temporalReview,claims}'), 0) NOT BETWEEN 1 AND 100
    OR jsonb_typeof(NEW.snapshot->'items') IS DISTINCT FROM 'array'
    OR COALESCE(jsonb_array_length(NEW.snapshot->'items'), 0) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(NEW.snapshot->'sources') IS DISTINCT FROM 'array'
    OR COALESCE(jsonb_array_length(NEW.snapshot->'sources'), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'temporal review snapshot scope or shape mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "media_temporal_review_receipts_insert_guard" BEFORE INSERT ON "media_temporal_review_receipts" FOR EACH ROW EXECUTE FUNCTION guard_media_temporal_review_receipt();

CREATE FUNCTION guard_media_temporal_operational_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operational_updates WHERE id=NEW.operational_update_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id AND status='DRAFT' AND is_active=false FOR SHARE) THEN
    RAISE EXCEPTION 'temporal handoff requires exact inactive operational update draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "media_temporal_operational_handoffs_insert_guard" BEFORE INSERT ON "media_temporal_operational_handoffs" FOR EACH ROW EXECUTE FUNCTION guard_media_temporal_operational_handoff();

CREATE FUNCTION reject_immutable_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable receipt cannot be changed'; END $$;
CREATE TRIGGER "media_temporal_review_receipts_immutable" BEFORE UPDATE OR DELETE ON "media_temporal_review_receipts" FOR EACH ROW EXECUTE FUNCTION reject_immutable_receipt_mutation();
CREATE TRIGGER "media_temporal_operational_handoffs_immutable" BEFORE UPDATE OR DELETE ON "media_temporal_operational_handoffs" FOR EACH ROW EXECUTE FUNCTION reject_immutable_receipt_mutation();
CREATE TRIGGER "media_temporal_review_receipts_no_truncate" BEFORE TRUNCATE ON "media_temporal_review_receipts" FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_receipt_mutation();
CREATE TRIGGER "media_temporal_operational_handoffs_no_truncate" BEFORE TRUNCATE ON "media_temporal_operational_handoffs" FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_receipt_mutation();
