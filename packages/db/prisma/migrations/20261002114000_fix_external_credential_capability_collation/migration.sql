BEGIN;

-- Preserve the credential evidence gates while matching JavaScript's canonical
-- capability sort independently of the database's default locale.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value COLLATE "C" FROM unnest(NEW."capabilities") value ORDER BY 1) THEN
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
