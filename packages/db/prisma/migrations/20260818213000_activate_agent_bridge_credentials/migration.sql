BEGIN;

CREATE TABLE "external_credential_activations" (
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "scope_key" VARCHAR(191) NOT NULL,
  "credential_id" TEXT NOT NULL,
  "activated_by" VARCHAR(191) NOT NULL,
  "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_credential_activations_pkey" PRIMARY KEY ("operation_id"),
  CONSTRAINT "external_credential_activations_hash_check" CHECK ("operation_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "external_credential_activations_actor_check" CHECK (char_length(btrim("activated_by")) BETWEEN 1 AND 191),
  CONSTRAINT "external_credential_activations_client_matches_tenant" CHECK ("client_id" = "tenant_id"),
  CONSTRAINT "external_credential_activations_scope_key_matches" CHECK ("scope_key" = "venue_id")
);

CREATE UNIQUE INDEX "external_credential_activations_credential_key"
  ON "external_credential_activations"("credential_id");
CREATE UNIQUE INDEX "external_credential_activations_exact_scope_key"
  ON "external_credential_activations"("credential_id", "tenant_id", "client_id", "scope_key");
CREATE INDEX "external_credential_activations_scope_idx"
  ON "external_credential_activations"("tenant_id", "client_id", "venue_id", "activated_at");

ALTER TABLE "external_credential_activations"
  ADD CONSTRAINT "external_credential_activations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "external_credential_activations_venue_scope_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "external_credential_activations_credential_scope_fkey"
    FOREIGN KEY ("credential_id", "tenant_id", "client_id", "scope_key")
    REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER external_credential_activations_append_only
  BEFORE UPDATE OR DELETE ON "external_credential_activations"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();
CREATE TRIGGER external_credential_activations_no_truncate
  BEFORE TRUNCATE ON "external_credential_activations"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();

CREATE FUNCTION pathfinder_check_external_credential_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_record RECORD;
BEGIN
  SELECT * INTO credential_record FROM "external_access_credentials"
    WHERE "id" = NEW."credential_id"
      AND "tenant_id" = NEW."tenant_id"
      AND "client_id" = NEW."client_id"
      AND "scope_key" = NEW."scope_key";
  IF credential_record."kind" <> 'MCP'
    OR credential_record."venue_id" IS DISTINCT FROM NEW."venue_id"
    OR credential_record."enabled" IS NOT TRUE
    OR credential_record."revoked_at" IS NOT NULL
    OR credential_record."updated_at" IS DISTINCT FROM NEW."activated_at"
    OR ('agent-runs:execute' = ANY(credential_record."capabilities")) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'bridge activation requires exact active MCP credential evidence';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER external_credential_activations_evidence_guard
  AFTER INSERT ON "external_credential_activations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pathfinder_check_external_credential_activation();

CREATE OR REPLACE FUNCTION pathfinder_guard_external_credential_disabled_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW."capabilities") < 1 THEN
    RAISE EXCEPTION 'external credential requires at least one capability';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW."enabled" OR NEW."revoked_at" IS NOT NULL OR NEW."last_used_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'new external credential must be disabled and unused';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."tenant_id", NEW."client_id", NEW."venue_id", NEW."scope_key", NEW."kind", NEW."label", NEW."capabilities", NEW."secret_prefix", NEW."secret_hash", NEW."hash_algorithm", NEW."expires_at", NEW."created_by", NEW."created_at") IS DISTINCT FROM ROW(OLD."tenant_id", OLD."client_id", OLD."venue_id", OLD."scope_key", OLD."kind", OLD."label", OLD."capabilities", OLD."secret_prefix", OLD."secret_hash", OLD."hash_algorithm", OLD."expires_at", OLD."created_by", OLD."created_at") THEN
      RAISE EXCEPTION 'external credential identity is immutable';
    END IF;
    IF NEW."last_used_at" IS DISTINCT FROM OLD."last_used_at" THEN
      RAISE EXCEPTION 'external credential use tracking is unavailable';
    END IF;
    IF OLD."enabled" = false AND NEW."enabled" = true
      AND OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NULL
      AND NEW."updated_at" > OLD."updated_at"
    THEN
      NULL;
    ELSIF OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL
      AND NEW."enabled" = false AND NEW."updated_at" = NEW."revoked_at"
    THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'only exact bridge activation or terminal revocation is allowed';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'external credential cannot be deleted'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['agent-runs:execute','ai-usage:read','clients:read','configuration:read','content:read','delegations:create','evaluations:read','evaluations:request','history:read','jobs:read','packages:draft','packages:read','questions:ask','questions:read','readiness:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
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
