BEGIN;

-- Admit the appearance interaction capabilities and venue creation for future MCP credentials.
-- This forward migration does not mutate or enable any existing credential or feature flag.
-- Client-scoped MCP activation evidence is reserved for the four venue/appearance capabilities.
ALTER TABLE "external_credential_activations"
  ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "external_credential_activations"
  DROP CONSTRAINT IF EXISTS "external_credential_activations_scope_key_matches";
ALTER TABLE "external_credential_activations"
  ADD CONSTRAINT "external_credential_activations_scope_key_matches"
  CHECK (("venue_id" IS NULL AND "scope_key" = '__CLIENT__') OR ("venue_id" IS NOT NULL AND "scope_key" = "venue_id"));

-- Integration replay queries for canonical venue and appearance actions bind this exact tuple.
CREATE INDEX IF NOT EXISTS "audit_logs_integration_idempotency_idx"
  ON "audit_logs"("tenant_id", "credential_id", "idempotency_key", "action");

CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential RECORD;
BEGIN
  SELECT * INTO credential FROM "external_access_credentials"
    WHERE "id" = NEW."credential_id" AND "tenant_id" = NEW."tenant_id"
      AND "client_id" = NEW."client_id" AND "scope_key" = NEW."scope_key";
  IF NOT FOUND OR credential."kind" <> 'MCP'
    OR credential."venue_id" IS DISTINCT FROM NEW."venue_id"
    OR credential."enabled" IS NOT TRUE OR credential."revoked_at" IS NOT NULL
    OR credential."updated_at" IS DISTINCT FROM NEW."activated_at" THEN
    RAISE EXCEPTION 'activation must match an enabled active MCP credential';
  END IF;
  IF NEW."venue_id" IS NOT NULL THEN
    IF NEW."scope_key" <> NEW."venue_id"
      OR ('agent-runs:execute' = ANY(credential."capabilities")) IS NOT TRUE THEN
      RAISE EXCEPTION 'venue activation requires an agent bridge capability';
    END IF;
  ELSE
    IF NEW."scope_key" <> '__CLIENT__'
      OR NEW."tenant_id" <> NEW."client_id"
      OR cardinality(credential."capabilities") = 0
      OR credential."capabilities" <@ ARRAY['venues:read','venues:create','appearance:read','appearance:write']::TEXT[] IS NOT TRUE THEN
      RAISE EXCEPTION 'client activation requires only venue and appearance capabilities';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-improvements:validate','agent-runs:execute','agent-runs:read','ai-usage:read','appearance:read','appearance:write','billing:propose','billing:read','characters:build','characters:execute','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','distribution:propose','distribution:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','intake-source:read','intake:draft','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:apply','packages:approve','packages:draft','packages:read','packages:reconcile','packages:revert','questions:ask','questions:read','readiness:read','reports:draft','reports:read','resources:read','retention:read','support:complete','support:draft','support:note','support:open','support:read','support:request-information','support:triage','updates:draft','updates:read','venues:create','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported MCP credential capability';
  END IF;
  IF NEW."kind" = 'PARTNER_READ_API' AND (NEW."capabilities" <@ ARRAY['approved-content:read','clients:read','configuration:read','readiness:read','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported partner credential capability';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "external_credential_operation_receipts" receipt WHERE receipt."credential_id" = NEW."id" AND receipt."operation_kind" IN ('ISSUE','ROTATE')) THEN
    RAISE EXCEPTION 'new external credential requires operation evidence';
  END IF;
  IF NEW."enabled" AND NOT EXISTS (
    SELECT 1 FROM "external_credential_activations" activation
      WHERE activation."credential_id" = NEW."id"
        AND activation."tenant_id" = NEW."tenant_id"
        AND activation."client_id" = NEW."client_id"
        AND activation."venue_id" IS NOT DISTINCT FROM NEW."venue_id"
        AND activation."scope_key" = NEW."scope_key"
        AND activation."activated_at" = NEW."updated_at"
  ) THEN
    RAISE EXCEPTION 'enabled external credential requires exact activation evidence';
  END IF;
  IF NEW."revoked_at" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "external_credential_revocations" revocation WHERE revocation."credential_id" = NEW."id" AND revocation."revoked_at" = NEW."revoked_at") THEN
    RAISE EXCEPTION 'external credential revocation requires exact timestamp evidence';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
