BEGIN;

CREATE TYPE "VenuePackageDuplicateAnalysisStatus" AS ENUM (
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'STALE'
);

-- Existing packages predate semantic duplicate evidence. Backfill an explicit,
-- truthful incomplete marker so typed readers fail closed and operators are
-- directed to save a new draft. The warning digest remains unchanged because
-- this adds an error, not a warning.
LOCK TABLE "venue_packages" IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER venue_packages_revision_guard ON "venue_packages";

UPDATE "venue_packages"
SET
  "validation_report" = jsonb_set(
    jsonb_set(
      "validation_report",
      '{semanticDuplicateScan}',
      '{
        "status": "INCOMPLETE",
        "similarityThreshold": 0.86,
        "scopes": {
          "places": {
            "embeddingProfile": "legacy-unavailable",
            "inputCount": 0,
            "scannedInputCount": 0,
            "existingCount": 0,
            "scannedExistingCount": 0
          },
          "knowledgeEntries": {
            "embeddingProfile": "legacy-unavailable",
            "inputCount": 0,
            "scannedInputCount": 0,
            "existingCount": 0,
            "scannedExistingCount": 0
          }
        }
      }'::jsonb,
      true
    ),
    '{errors}',
    COALESCE("validation_report" -> 'errors', '[]'::jsonb)
      || '[{
        "code": "SEMANTIC_SCAN_INCOMPLETE",
        "path": "semanticDuplicateScan",
        "message": "This package predates semantic duplicate analysis. Save a new draft to obtain current evidence."
      }]'::jsonb,
    true
  ),
  "preview_plan" = jsonb_set(
    jsonb_set(
      "preview_plan",
      '{report,semanticDuplicateScan}',
      '{
        "status": "INCOMPLETE",
        "similarityThreshold": 0.86,
        "scopes": {
          "places": {
            "embeddingProfile": "legacy-unavailable",
            "inputCount": 0,
            "scannedInputCount": 0,
            "existingCount": 0,
            "scannedExistingCount": 0
          },
          "knowledgeEntries": {
            "embeddingProfile": "legacy-unavailable",
            "inputCount": 0,
            "scannedInputCount": 0,
            "existingCount": 0,
            "scannedExistingCount": 0
          }
        }
      }'::jsonb,
      true
    ),
    '{report,errors}',
    COALESCE("preview_plan" #> '{report,errors}', '[]'::jsonb)
      || '[{
        "code": "SEMANTIC_SCAN_INCOMPLETE",
        "path": "semanticDuplicateScan",
        "message": "This package predates semantic duplicate analysis. Save a new draft to obtain current evidence."
      }]'::jsonb,
    true
  );

CREATE TRIGGER venue_packages_revision_guard
  BEFORE UPDATE OR DELETE ON "venue_packages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_revision();

CREATE UNIQUE INDEX "venue_packages_id_tenant_id_venue_id_key"
  ON "venue_packages"("id", "tenant_id", "venue_id");

CREATE TABLE "venue_package_duplicate_analyses" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "draft_key" UUID NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "base_digest" CHAR(64) NOT NULL,
  "status" "VenuePackageDuplicateAnalysisStatus" NOT NULL DEFAULT 'RUNNING',
  "claim_token" UUID NOT NULL,
  "embedding_profiles" JSONB NOT NULL,
  "similarity_threshold" DOUBLE PRECISION NOT NULL,
  "result" JSONB,
  "usage_event_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "draft_id" TEXT,
  "error_code" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "venue_package_duplicate_analyses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_package_duplicate_analyses_threshold_check"
    CHECK ("similarity_threshold" >= -1 AND "similarity_threshold" <= 1),
  CONSTRAINT "venue_package_duplicate_analyses_lifecycle_check" CHECK (
    ("status" = 'RUNNING'
      AND "result" IS NULL AND "draft_id" IS NULL AND "error_code" IS NULL
      AND "completed_at" IS NULL)
    OR
    ("status" = 'COMPLETE'
      AND "result" IS NOT NULL AND "draft_id" IS NOT NULL AND "error_code" IS NULL
      AND "completed_at" IS NOT NULL)
    OR
    ("status" IN ('FAILED', 'STALE')
      AND "result" IS NULL AND "draft_id" IS NULL AND "error_code" IS NOT NULL
      AND "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "venue_package_duplicate_analyses_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "venue_package_duplicate_analyses_venue_id_tenant_id_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "venue_package_duplicate_analyses_draft_scope_fkey"
    FOREIGN KEY ("draft_id", "tenant_id", "venue_id")
    REFERENCES "venue_packages"("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

COMMENT ON COLUMN "venue_package_duplicate_analyses"."status" IS
  'Operation receipt status. COMPLETE means immutable evidence and a draft were stored; result.semanticDuplicateScan.status may truthfully be INCOMPLETE and block approval.';

CREATE UNIQUE INDEX "venue_package_duplicate_analyses_tenant_id_venue_id_draft_key_key"
  ON "venue_package_duplicate_analyses"("tenant_id", "venue_id", "draft_key");
CREATE UNIQUE INDEX "venue_package_duplicate_analyses_draft_id_key"
  ON "venue_package_duplicate_analyses"("draft_id");
CREATE UNIQUE INDEX "venue_package_duplicate_analyses_draft_id_tenant_id_venue_id_key"
  ON "venue_package_duplicate_analyses"("draft_id", "tenant_id", "venue_id");
CREATE INDEX "venue_package_duplicate_analyses_tenant_id_status_created_at_idx"
  ON "venue_package_duplicate_analyses"("tenant_id", "status", "created_at");
CREATE INDEX "venue_package_duplicate_analyses_tenant_id_venue_id_created_at_idx"
  ON "venue_package_duplicate_analyses"("tenant_id", "venue_id", "created_at");

CREATE FUNCTION pathfinder_guard_venue_package_duplicate_analysis() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'venue package duplicate analyses are immutable evidence';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."draft_key" IS DISTINCT FROM OLD."draft_key"
    OR NEW."payload_hash" IS DISTINCT FROM OLD."payload_hash"
    OR NEW."base_digest" IS DISTINCT FROM OLD."base_digest"
    OR NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
    OR NEW."embedding_profiles" IS DISTINCT FROM OLD."embedding_profiles"
    OR NEW."similarity_threshold" IS DISTINCT FROM OLD."similarity_threshold"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'venue package duplicate analysis identity is immutable';
  END IF;

  IF OLD."status" <> 'RUNNING'
    OR NEW."status" NOT IN ('COMPLETE', 'FAILED', 'STALE')
  THEN
    RAISE EXCEPTION 'invalid venue package duplicate analysis transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION pathfinder_guard_venue_package_duplicate_analysis_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'venue package duplicate analyses are immutable evidence';
END;
$$;

CREATE TRIGGER venue_package_duplicate_analyses_revision_guard
  BEFORE UPDATE OR DELETE ON "venue_package_duplicate_analyses"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_duplicate_analysis();

CREATE TRIGGER venue_package_duplicate_analyses_truncate_guard
  BEFORE TRUNCATE ON "venue_package_duplicate_analyses"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_venue_package_duplicate_analysis_truncate();

COMMIT;
