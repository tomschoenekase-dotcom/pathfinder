BEGIN;

CREATE TYPE "ExternalCredentialKind" AS ENUM ('MCP', 'PARTNER_READ_API');
CREATE TYPE "ExternalCredentialHashAlgorithm" AS ENUM ('ARGON2ID');

CREATE TABLE "external_access_credentials" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "scope_key" VARCHAR(191) NOT NULL,
  "kind" "ExternalCredentialKind" NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "capabilities" TEXT[] NOT NULL,
  "secret_prefix" VARCHAR(24) NOT NULL,
  "secret_hash" VARCHAR(255) NOT NULL,
  "hash_algorithm" "ExternalCredentialHashAlgorithm" NOT NULL DEFAULT 'ARGON2ID',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_access_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_credentials_client_matches_tenant" CHECK ("client_id" = "tenant_id"),
  CONSTRAINT "external_credentials_scope_key_matches" CHECK ("scope_key" = COALESCE("venue_id", '__CLIENT__')),
  CONSTRAINT "external_credentials_argon2id_only" CHECK ("secret_hash" LIKE '$argon2id$%'),
  CONSTRAINT "external_credentials_prefix_not_secret" CHECK (length("secret_prefix") BETWEEN 6 AND 24 AND "secret_hash" <> "secret_prefix"),
  CONSTRAINT "external_credentials_capability_bound" CHECK (cardinality("capabilities") BETWEEN 1 AND 50),
  CONSTRAINT "external_credentials_revoked_disabled" CHECK ("revoked_at" IS NULL OR "enabled" = false)
);

CREATE UNIQUE INDEX "external_credentials_exact_scope_key" ON "external_access_credentials"("id", "tenant_id", "client_id", "scope_key");
CREATE UNIQUE INDEX "external_credentials_prefix_key" ON "external_access_credentials"("tenant_id", "kind", "secret_prefix");
CREATE INDEX "external_credentials_scope_created_idx" ON "external_access_credentials"("tenant_id", "client_id", "venue_id", "kind", "created_at", "id");
ALTER TABLE "external_access_credentials" ADD CONSTRAINT "external_credentials_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_access_credentials" ADD CONSTRAINT "external_credentials_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "external_credential_rotations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "scope_key" VARCHAR(191) NOT NULL,
  "previous_credential_id" TEXT NOT NULL,
  "new_credential_id" TEXT NOT NULL,
  "rotated_by" VARCHAR(191) NOT NULL,
  "rotated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_credential_rotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_rotations_distinct_credentials" CHECK ("previous_credential_id" <> "new_credential_id"),
  CONSTRAINT "external_rotations_client_matches_tenant" CHECK ("client_id" = "tenant_id"),
  CONSTRAINT "external_rotations_scope_key_matches" CHECK ("scope_key" = COALESCE("venue_id", '__CLIENT__'))
);
CREATE UNIQUE INDEX "external_rotations_pair_scope_key" ON "external_credential_rotations"("previous_credential_id", "new_credential_id", "tenant_id", "client_id", "scope_key");
CREATE UNIQUE INDEX "external_rotations_new_scope_key" ON "external_credential_rotations"("new_credential_id", "tenant_id", "client_id", "scope_key");
CREATE INDEX "external_rotations_scope_created_idx" ON "external_credential_rotations"("tenant_id", "client_id", "venue_id", "rotated_at", "id");
ALTER TABLE "external_credential_rotations" ADD CONSTRAINT "external_rotations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_rotations" ADD CONSTRAINT "external_rotations_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_rotations" ADD CONSTRAINT "external_rotations_previous_scope_fkey" FOREIGN KEY ("previous_credential_id", "tenant_id", "client_id", "scope_key") REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_rotations" ADD CONSTRAINT "external_rotations_new_scope_fkey" FOREIGN KEY ("new_credential_id", "tenant_id", "client_id", "scope_key") REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "external_credential_revocations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "scope_key" VARCHAR(191) NOT NULL,
  "credential_id" TEXT NOT NULL,
  "revoked_by" VARCHAR(191) NOT NULL,
  "reason_code" VARCHAR(100) NOT NULL,
  "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_credential_revocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_revocations_client_matches_tenant" CHECK ("client_id" = "tenant_id"),
  CONSTRAINT "external_revocations_scope_key_matches" CHECK ("scope_key" = COALESCE("venue_id", '__CLIENT__'))
);
CREATE UNIQUE INDEX "external_revocations_credential_key" ON "external_credential_revocations"("credential_id");
CREATE UNIQUE INDEX "external_revocations_exact_scope_key" ON "external_credential_revocations"("credential_id", "tenant_id", "client_id", "scope_key");
CREATE INDEX "external_revocations_scope_created_idx" ON "external_credential_revocations"("tenant_id", "client_id", "venue_id", "revoked_at", "id");
ALTER TABLE "external_credential_revocations" ADD CONSTRAINT "external_revocations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_revocations" ADD CONSTRAINT "external_revocations_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "external_credential_revocations" ADD CONSTRAINT "external_revocations_credential_scope_fkey" FOREIGN KEY ("credential_id", "tenant_id", "client_id", "scope_key") REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_external_credential_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER external_credential_rotations_append_only BEFORE UPDATE OR DELETE ON "external_credential_rotations" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();
CREATE TRIGGER external_credential_rotations_no_truncate BEFORE TRUNCATE ON "external_credential_rotations" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();
CREATE TRIGGER external_credential_revocations_append_only BEFORE UPDATE OR DELETE ON "external_credential_revocations" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();
CREATE TRIGGER external_credential_revocations_no_truncate BEFORE TRUNCATE ON "external_credential_revocations" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_external_credential_evidence_mutation();

COMMIT;
