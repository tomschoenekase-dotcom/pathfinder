-- Immutable native Venue Deployment Manifest v2 review evidence. Historical
-- VenuePackage rows are intentionally not backfilled because no canonical
-- manifest identity, evidence or FULL base can be inferred safely.
BEGIN;

CREATE TYPE "VenuePackageManifestArtifactType" AS ENUM ('FULL', 'PATCH');
CREATE TYPE "VenuePackageManifestMaterializationStatus" AS ENUM ('MATERIALIZABLE', 'NOT_MATERIALIZABLE');

CREATE TABLE "venue_package_manifest_artifacts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "artifact_kind" VARCHAR(64) NOT NULL DEFAULT 'VENUE_DEPLOYMENT_MANIFEST_V2',
  "manifest_schema_version" INTEGER NOT NULL,
  "package_type" "VenuePackageManifestArtifactType" NOT NULL,
  "manifest_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "canonical_manifest" JSONB NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "base_manifest_hash" CHAR(64),
  "evidence_digest" CHAR(64) NOT NULL,
  "materialization_status" "VenuePackageManifestMaterializationStatus" NOT NULL,
  "materialization_report" JSONB NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_package_manifest_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_package_manifest_artifacts_kind_check" CHECK ("artifact_kind" = 'VENUE_DEPLOYMENT_MANIFEST_V2'),
  CONSTRAINT "venue_package_manifest_artifacts_version_check" CHECK ("manifest_schema_version" = 2),
  CONSTRAINT "venue_package_manifest_artifacts_hash_check" CHECK ("manifest_hash" ~ '^[a-f0-9]{64}$' AND "evidence_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "venue_package_manifest_artifacts_base_check" CHECK (("package_type" = 'FULL' AND "base_manifest_hash" IS NULL) OR ("package_type" = 'PATCH' AND "base_manifest_hash" IS NOT NULL)),
  CONSTRAINT "venue_package_manifest_artifacts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "venue_package_manifest_artifacts_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "venue_package_manifest_artifacts_manifest_key" ON "venue_package_manifest_artifacts"("tenant_id", "venue_id", "manifest_id");
CREATE UNIQUE INDEX "venue_package_manifest_artifacts_idempotency_key" ON "venue_package_manifest_artifacts"("tenant_id", "venue_id", "idempotency_key");
CREATE UNIQUE INDEX "venue_package_manifest_artifacts_hash_key" ON "venue_package_manifest_artifacts"("tenant_id", "venue_id", "manifest_hash");
CREATE UNIQUE INDEX "venue_package_manifest_artifacts_id_scope_key" ON "venue_package_manifest_artifacts"("id", "tenant_id", "venue_id");
CREATE INDEX "venue_package_manifest_artifacts_scope_idx" ON "venue_package_manifest_artifacts"("tenant_id", "venue_id", "package_type", "created_at");

ALTER TABLE "venue_packages" ADD COLUMN "manifest_artifact_id" TEXT;
CREATE UNIQUE INDEX "venue_packages_manifest_artifact_key" ON "venue_packages"("manifest_artifact_id");
CREATE UNIQUE INDEX "venue_packages_manifest_artifact_scope_key" ON "venue_packages"("manifest_artifact_id", "tenant_id", "venue_id");
ALTER TABLE "venue_packages" ADD CONSTRAINT "venue_packages_manifest_artifact_fkey"
  FOREIGN KEY ("manifest_artifact_id", "tenant_id", "venue_id") REFERENCES "venue_package_manifest_artifacts"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The pre-existing revision guard permits lifecycle transitions only. Extend it
-- narrowly for the one atomic DRAFT-sidecar attachment performed at creation.
CREATE OR REPLACE FUNCTION pathfinder_guard_venue_package_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'venue package revisions are immutable';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'DRAFT'
    AND OLD."manifest_artifact_id" IS NULL AND NEW."manifest_artifact_id" IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['manifest_artifact_id','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['manifest_artifact_id','updated_at'])
  THEN
    RETURN NEW;
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."draft_key" IS DISTINCT FROM OLD."draft_key"
    OR NEW."schema_version" IS DISTINCT FROM OLD."schema_version"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."payload_hash" IS DISTINCT FROM OLD."payload_hash"
    OR NEW."base_digest" IS DISTINCT FROM OLD."base_digest"
    OR NEW."validation_report" IS DISTINCT FROM OLD."validation_report"
    OR NEW."preview_plan" IS DISTINCT FROM OLD."preview_plan"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'venue package revision content is immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'APPLIED')
    OR (OLD."status" = 'APPLIED' AND NEW."status" = 'REVERTED')
  ) THEN
    RAISE EXCEPTION 'invalid venue package lifecycle transition';
  END IF;
  IF OLD."status" <> 'DRAFT'
    AND (NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
      OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
      OR NEW."approved_command_key" IS DISTINCT FROM OLD."approved_command_key"
      OR NEW."approval_warning_digest" IS DISTINCT FROM OLD."approval_warning_digest"
      OR NEW."approved_warning_codes" IS DISTINCT FROM OLD."approved_warning_codes")
  THEN
    RAISE EXCEPTION 'venue package approval attribution is immutable';
  END IF;
  IF OLD."status" = 'APPLIED'
    AND (NEW."applied_by" IS DISTINCT FROM OLD."applied_by"
      OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at"
      OR NEW."applied_command_key" IS DISTINCT FROM OLD."applied_command_key"
      OR NEW."applied_entities" IS DISTINCT FROM OLD."applied_entities")
  THEN
    RAISE EXCEPTION 'venue package application evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pathfinder_guard_venue_package_manifest_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'venue package manifest artifacts are immutable';
  END IF;
  IF jsonb_typeof(NEW."canonical_manifest") IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW."materialization_report") IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW."materialization_report" -> 'coverage') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW."materialization_report" -> 'issues') IS DISTINCT FROM 'array'
    OR NEW."canonical_manifest" ->> 'schemaVersion' IS DISTINCT FROM '2'
    OR NEW."canonical_manifest" ->> 'packageType' IS DISTINCT FROM NEW."package_type"::text
    OR NEW."canonical_manifest" ->> 'manifestId' IS DISTINCT FROM NEW."manifest_id"::text
    OR NEW."canonical_manifest" ->> 'idempotencyKey' IS DISTINCT FROM NEW."idempotency_key"::text
    OR NEW."canonical_manifest" ->> 'venueRef' IS DISTINCT FROM NEW."venue_id"
    OR NEW."materialization_report" ->> 'artifactKind' IS DISTINCT FROM NEW."artifact_kind"
    OR NEW."materialization_report" ->> 'manifestHash' IS DISTINCT FROM NEW."manifest_hash"
    OR NEW."materialization_report" ->> 'status' IS DISTINCT FROM NEW."materialization_status"::text
    OR NEW."materialization_report" ->> 'baseManifestHash' IS DISTINCT FROM NEW."base_manifest_hash"
    OR (NEW."materialization_report" -> 'coverage' ?& ARRAY['IDENTITY','BRANDING','AI_CONFIGURATION','CAPABILITIES','CONTENT','ASSETS','EVALUATION']) IS DISTINCT FROM TRUE
    OR jsonb_object_length(NEW."materialization_report" -> 'coverage') IS DISTINCT FROM 7
    OR EXISTS (
      SELECT 1 FROM jsonb_each_text(NEW."materialization_report" -> 'coverage') AS item
      WHERE item.value NOT IN ('COMPLETE', 'BLOCKED')
    )
    OR (NEW."materialization_status" = 'MATERIALIZABLE' AND (
      jsonb_typeof(NEW."materialization_report" -> 'legacyPayloadHash') IS DISTINCT FROM 'string'
      OR NEW."materialization_report" ->> 'legacyPayloadHash' !~ '^[a-f0-9]{64}$'
    ))
    OR (NEW."materialization_status" = 'NOT_MATERIALIZABLE'
      AND NEW."materialization_report" -> 'legacyPayloadHash' IS DISTINCT FROM 'null'::jsonb)
    OR (NEW."package_type" = 'PATCH' AND NEW."canonical_manifest" ->> 'baseManifestHash' IS DISTINCT FROM NEW."base_manifest_hash")
    OR (NEW."package_type" = 'FULL' AND NEW."canonical_manifest" ? 'baseManifestHash')
  THEN
    RAISE EXCEPTION 'venue package manifest artifact scalar and JSON evidence disagree';
  END IF;
  IF NEW."package_type" = 'PATCH' AND NOT EXISTS (
    SELECT 1 FROM public."venue_package_manifest_artifacts" AS base
    WHERE base."tenant_id" = NEW."tenant_id"
      AND base."venue_id" = NEW."venue_id"
      AND base."package_type" = 'FULL'
      AND base."manifest_hash" = NEW."base_manifest_hash"
  ) THEN
    RAISE EXCEPTION 'patch manifest base must be a persisted same-scope FULL artifact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pathfinder_guard_venue_package_manifest_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE artifact record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."manifest_artifact_id" IS NOT NULL
    AND NEW."manifest_artifact_id" IS DISTINCT FROM OLD."manifest_artifact_id" THEN
    RAISE EXCEPTION 'venue package manifest link is immutable';
  END IF;
  IF NEW."manifest_artifact_id" IS NULL THEN RETURN NEW; END IF;
  SELECT "package_type", "materialization_status", "materialization_report"
  INTO artifact
  FROM public."venue_package_manifest_artifacts"
  WHERE "id" = NEW."manifest_artifact_id"
    AND "tenant_id" = NEW."tenant_id"
    AND "venue_id" = NEW."venue_id";
  IF NOT FOUND
    OR NEW."status" <> 'DRAFT'
    OR artifact."package_type" <> 'PATCH'
    OR artifact."materialization_status" <> 'MATERIALIZABLE'
    OR artifact."materialization_report" ->> 'status' <> 'MATERIALIZABLE'
    OR artifact."materialization_report" ->> 'legacyPayloadHash' IS DISTINCT FROM NEW."payload_hash"
  THEN
    RAISE EXCEPTION 'venue package manifest link requires an exact materializable PATCH DRAFT';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venue_package_manifest_artifact_insert_guard
  BEFORE INSERT ON "venue_package_manifest_artifacts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_manifest_artifact();
CREATE TRIGGER venue_package_manifest_artifact_update_guard
  BEFORE UPDATE ON "venue_package_manifest_artifacts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_manifest_artifact();
CREATE TRIGGER venue_package_manifest_artifact_delete_guard
  BEFORE DELETE ON "venue_package_manifest_artifacts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_manifest_artifact();
CREATE TRIGGER venue_package_manifest_artifact_truncate_guard
  BEFORE TRUNCATE ON "venue_package_manifest_artifacts"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_venue_package_manifest_artifact();

CREATE TRIGGER venue_package_manifest_link_guard
  BEFORE INSERT OR UPDATE OF "manifest_artifact_id" ON "venue_packages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_manifest_link();

COMMIT;
