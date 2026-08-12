BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "external_credential_rotations"
    GROUP BY "previous_credential_id" HAVING COUNT(*) > 1
  ) THEN RAISE EXCEPTION 'historical external credential has multiple outgoing rotations'; END IF;
END $$;

CREATE TYPE "ExternalCredentialOperationKind" AS ENUM ('ISSUE', 'ROTATE', 'REVOKE');

CREATE TABLE "external_credential_operation_receipts" (
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "operation_kind" "ExternalCredentialOperationKind" NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "scope_key" VARCHAR(191) NOT NULL,
  "credential_id" TEXT NOT NULL,
  "previous_credential_id" TEXT,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_credential_operation_receipts_pkey" PRIMARY KEY ("operation_id"),
  CONSTRAINT "external_credential_operations_hash_check" CHECK ("operation_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "external_credential_operations_actor_check" CHECK (char_length(btrim("actor_id")) BETWEEN 1 AND 191),
  CONSTRAINT "external_credential_operations_client_matches_tenant" CHECK ("client_id" = "tenant_id"),
  CONSTRAINT "external_credential_operations_scope_key_matches" CHECK ("scope_key" = COALESCE("venue_id", '__CLIENT__')),
  CONSTRAINT "external_credential_operations_previous_shape" CHECK (
    ("operation_kind" = 'ROTATE' AND "previous_credential_id" IS NOT NULL AND "previous_credential_id" <> "credential_id") OR
    ("operation_kind" IN ('ISSUE', 'REVOKE') AND "previous_credential_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "external_credential_operations_result_kind_key"
  ON "external_credential_operation_receipts"("credential_id", "operation_kind");
CREATE UNIQUE INDEX "external_credential_operations_single_origin_key"
  ON "external_credential_operation_receipts"("credential_id")
  WHERE "operation_kind" IN ('ISSUE', 'ROTATE');
CREATE INDEX "external_credential_operations_scope_idx"
  ON "external_credential_operation_receipts"("tenant_id", "client_id", "venue_id", "created_at");
CREATE UNIQUE INDEX "external_rotations_previous_once_key"
  ON "external_credential_rotations"("previous_credential_id");
ALTER TABLE "external_credential_operation_receipts" ADD CONSTRAINT "external_credential_operations_result_scope_fkey"
  FOREIGN KEY ("credential_id", "tenant_id", "client_id", "scope_key") REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_operation_receipts" ADD CONSTRAINT "external_credential_operations_previous_scope_fkey"
  FOREIGN KEY ("previous_credential_id", "tenant_id", "client_id", "scope_key") REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_external_credential_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'external credential operation receipt is append-only'; END IF;
  IF NEW."operation_kind" = 'ISSUE' AND NOT EXISTS (
    SELECT 1 FROM "external_access_credentials" c WHERE c."id" = NEW."credential_id" AND c."tenant_id" = NEW."tenant_id" AND c."client_id" = NEW."client_id" AND c."scope_key" = NEW."scope_key" AND c."enabled" = false AND c."revoked_at" IS NULL AND c."created_by" = NEW."actor_id" AND c."created_at" = NEW."created_at"
  ) THEN RAISE EXCEPTION 'issue receipt requires disabled credential'; END IF;
  IF NEW."operation_kind" = 'ROTATE' AND NOT EXISTS (
    SELECT 1 FROM "external_credential_rotations" r WHERE r."previous_credential_id" = NEW."previous_credential_id" AND r."new_credential_id" = NEW."credential_id" AND r."tenant_id" = NEW."tenant_id" AND r."client_id" = NEW."client_id" AND r."scope_key" = NEW."scope_key" AND r."rotated_by" = NEW."actor_id" AND r."rotated_at" = NEW."created_at"
  ) THEN RAISE EXCEPTION 'rotate receipt requires exact lineage'; END IF;
  IF NEW."operation_kind" = 'REVOKE' AND NOT EXISTS (
    SELECT 1 FROM "external_credential_revocations" r WHERE r."credential_id" = NEW."credential_id" AND r."tenant_id" = NEW."tenant_id" AND r."client_id" = NEW."client_id" AND r."scope_key" = NEW."scope_key" AND r."revoked_by" = NEW."actor_id" AND r."revoked_at" = NEW."created_at" AND r."reason_code" <> 'ROTATED'
  ) THEN RAISE EXCEPTION 'revoke receipt requires exact revocation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_credential_operation_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "external_credential_operation_receipts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_external_credential_operation_receipt();
CREATE TRIGGER external_credential_operation_receipts_no_truncate
  BEFORE TRUNCATE ON "external_credential_operation_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();

-- Lifecycle writes remain disabled-only. Rotation/revocation must be paired
-- with their append-only evidence in the same transaction.
CREATE FUNCTION pathfinder_guard_external_credential_disabled_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW."capabilities") < 1 THEN
    RAISE EXCEPTION 'external credential requires at least one capability';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW."enabled" OR NEW."revoked_at" IS NOT NULL OR NEW."last_used_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'new external credential must be disabled and unused';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."enabled" THEN RAISE EXCEPTION 'external credential enablement is unavailable'; END IF;
    IF ROW(NEW."tenant_id", NEW."client_id", NEW."venue_id", NEW."scope_key", NEW."kind", NEW."label", NEW."capabilities", NEW."secret_prefix", NEW."secret_hash", NEW."hash_algorithm", NEW."expires_at", NEW."created_by", NEW."created_at") IS DISTINCT FROM ROW(OLD."tenant_id", OLD."client_id", OLD."venue_id", OLD."scope_key", OLD."kind", OLD."label", OLD."capabilities", OLD."secret_prefix", OLD."secret_hash", OLD."hash_algorithm", OLD."expires_at", OLD."created_by", OLD."created_at") THEN
      RAISE EXCEPTION 'external credential identity is immutable';
    END IF;
    IF NEW."last_used_at" IS DISTINCT FROM OLD."last_used_at" THEN RAISE EXCEPTION 'external credential use tracking is unavailable'; END IF;
    IF OLD."revoked_at" IS NOT NULL OR NEW."revoked_at" IS NULL OR NEW."updated_at" IS DISTINCT FROM NEW."revoked_at" THEN
      RAISE EXCEPTION 'only an exact terminal external credential revocation update is allowed';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'external credential cannot be deleted'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER external_access_credentials_disabled_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON "external_access_credentials"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_external_credential_disabled_lifecycle();

CREATE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['ai-usage:read','clients:read','configuration:read','content:read','evaluations:read','evaluations:request','history:read','jobs:read','packages:draft','packages:read','readiness:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported MCP credential capability';
  END IF;
  IF NEW."kind" = 'PARTNER_READ_API' AND (NEW."capabilities" <@ ARRAY['approved-content:read','clients:read','configuration:read','readiness:read','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported partner credential capability';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "external_credential_operation_receipts" receipt WHERE receipt."credential_id" = NEW."id" AND receipt."operation_kind" IN ('ISSUE','ROTATE')) THEN
    RAISE EXCEPTION 'new external credential requires operation evidence';
  END IF;
  IF NEW."revoked_at" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "external_credential_revocations" revocation WHERE revocation."credential_id" = NEW."id" AND revocation."revoked_at" = NEW."revoked_at") THEN
    RAISE EXCEPTION 'external credential revocation requires exact timestamp evidence';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER external_access_credentials_evidence_guard
  AFTER INSERT OR UPDATE ON "external_access_credentials"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pathfinder_check_external_credential_evidence();

CREATE FUNCTION pathfinder_check_external_credential_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_record RECORD; new_record RECORD;
BEGIN
  IF TG_TABLE_NAME = 'external_credential_rotations' THEN
    IF char_length(btrim(NEW."rotated_by")) < 1 THEN RAISE EXCEPTION 'external credential rotation actor is required'; END IF;
    SELECT * INTO previous_record FROM "external_access_credentials" WHERE "id" = NEW."previous_credential_id" AND "tenant_id" = NEW."tenant_id" AND "client_id" = NEW."client_id" AND "scope_key" = NEW."scope_key";
    SELECT * INTO new_record FROM "external_access_credentials" WHERE "id" = NEW."new_credential_id" AND "tenant_id" = NEW."tenant_id" AND "client_id" = NEW."client_id" AND "scope_key" = NEW."scope_key";
    IF previous_record."venue_id" IS DISTINCT FROM NEW."venue_id" OR new_record."venue_id" IS DISTINCT FROM NEW."venue_id" OR
       previous_record."kind" IS DISTINCT FROM new_record."kind" OR previous_record."label" IS DISTINCT FROM new_record."label" OR
       previous_record."capabilities" IS DISTINCT FROM new_record."capabilities" OR previous_record."expires_at" IS DISTINCT FROM new_record."expires_at" OR
       new_record."created_by" IS DISTINCT FROM NEW."rotated_by" OR new_record."created_at" IS DISTINCT FROM NEW."rotated_at" OR
       previous_record."revoked_at" IS DISTINCT FROM NEW."rotated_at" OR previous_record."enabled" OR new_record."enabled" OR new_record."revoked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'external credential rotation lineage is inconsistent';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "external_credential_operation_receipts" receipt
      WHERE receipt."operation_kind" = 'ROTATE'
        AND receipt."previous_credential_id" = NEW."previous_credential_id"
        AND receipt."credential_id" = NEW."new_credential_id"
        AND receipt."tenant_id" = NEW."tenant_id"
        AND receipt."client_id" = NEW."client_id"
        AND receipt."scope_key" = NEW."scope_key"
        AND receipt."actor_id" = NEW."rotated_by"
        AND receipt."created_at" = NEW."rotated_at"
    ) THEN RAISE EXCEPTION 'external credential rotation requires exact operation evidence'; END IF;
  ELSE
    IF char_length(btrim(NEW."revoked_by")) < 1 OR char_length(btrim(NEW."reason_code")) < 1 THEN RAISE EXCEPTION 'external credential revocation actor and reason are required'; END IF;
    SELECT * INTO previous_record FROM "external_access_credentials" WHERE "id" = NEW."credential_id" AND "tenant_id" = NEW."tenant_id" AND "client_id" = NEW."client_id" AND "scope_key" = NEW."scope_key";
    IF previous_record."venue_id" IS DISTINCT FROM NEW."venue_id" OR previous_record."revoked_at" IS DISTINCT FROM NEW."revoked_at" OR previous_record."enabled" THEN
      RAISE EXCEPTION 'external credential revocation lineage is inconsistent';
    END IF;
    IF NEW."reason_code" = 'ROTATED' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "external_credential_operation_receipts" receipt
        WHERE receipt."operation_kind" = 'ROTATE'
          AND receipt."previous_credential_id" = NEW."credential_id"
          AND receipt."tenant_id" = NEW."tenant_id"
          AND receipt."client_id" = NEW."client_id"
          AND receipt."scope_key" = NEW."scope_key"
          AND receipt."actor_id" = NEW."revoked_by"
          AND receipt."created_at" = NEW."revoked_at"
      ) THEN RAISE EXCEPTION 'rotated credential revocation requires exact operation evidence'; END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM "external_credential_operation_receipts" receipt
      WHERE receipt."operation_kind" = 'REVOKE'
        AND receipt."credential_id" = NEW."credential_id"
        AND receipt."tenant_id" = NEW."tenant_id"
        AND receipt."client_id" = NEW."client_id"
        AND receipt."scope_key" = NEW."scope_key"
        AND receipt."actor_id" = NEW."revoked_by"
        AND receipt."created_at" = NEW."revoked_at"
    ) THEN RAISE EXCEPTION 'external credential revocation requires exact operation evidence'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER external_credential_rotations_insert_guard
  AFTER INSERT ON "external_credential_rotations" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pathfinder_check_external_credential_lineage();
CREATE CONSTRAINT TRIGGER external_credential_revocations_insert_guard
  AFTER INSERT ON "external_credential_revocations" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pathfinder_check_external_credential_lineage();

COMMIT;
