BEGIN;

-- Retain immutable policy-v1 receipts; admit the bounded PDF-aware policy-v2 shape.
ALTER TABLE "intake_website_research_receipts"
  DROP CONSTRAINT "intake_website_research_receipts_discovery_snapshot_shape_check";

ALTER TABLE "intake_website_research_receipts"
  ADD CONSTRAINT "intake_website_research_receipts_discovery_snapshot_shape_check" CHECK (
    (
      CASE
        WHEN "discovery_snapshot" IS NULL THEN TRUE
        WHEN jsonb_typeof("discovery_snapshot") IS DISTINCT FROM 'object' THEN FALSE
        WHEN jsonb_typeof("discovery_snapshot" -> 'policyVersion') IS DISTINCT FROM 'number' THEN FALSE
        WHEN "discovery_snapshot" ->> 'policyVersion' NOT IN ('1', '2') THEN FALSE
        WHEN jsonb_typeof("discovery_snapshot" -> 'observedAt') IS DISTINCT FROM 'string' THEN FALSE
        WHEN jsonb_typeof("discovery_snapshot" -> 'items') IS DISTINCT FROM 'array' THEN FALSE
        WHEN jsonb_array_length("discovery_snapshot" -> 'items') > 1000 THEN FALSE
        WHEN jsonb_typeof("discovery_snapshot" -> 'omittedCount') IS DISTINCT FROM 'number' THEN FALSE
        WHEN "discovery_snapshot" ->> 'omittedCount' !~ '^(0|[1-9][0-9]{0,6})$' THEN FALSE
        WHEN ("discovery_snapshot" ->> 'omittedCount')::INTEGER > 1000000 THEN FALSE
        WHEN octet_length("discovery_snapshot"::text) > 8000000 THEN FALSE
        ELSE TRUE
      END
    ) IS TRUE
  );

COMMIT;
