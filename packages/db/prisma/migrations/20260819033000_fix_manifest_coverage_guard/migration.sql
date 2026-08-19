-- PostgreSQL exposes jsonb_array_length but no jsonb_object_length function.
-- Count the validated coverage object's keys through jsonb_object_keys instead.
CREATE OR REPLACE FUNCTION pathfinder_guard_venue_package_manifest_artifact()
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
    OR (SELECT count(*) FROM jsonb_object_keys(NEW."materialization_report" -> 'coverage')) <> 7
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
