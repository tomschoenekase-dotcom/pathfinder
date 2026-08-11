BEGIN;

CREATE TYPE "NormalizedContentModuleKind" AS ENUM ('SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP');
CREATE TYPE "NormalizedContentAudience" AS ENUM ('PUBLIC', 'CLIENT', 'OPERATOR');

ALTER TABLE "places" ADD CONSTRAINT "places_id_tenant_id_key" UNIQUE ("id", "tenant_id");
ALTER TABLE "places" ADD CONSTRAINT "places_id_tenant_id_venue_id_key" UNIQUE ("id", "tenant_id", "venue_id");

CREATE TABLE "content_module_identities" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_module_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_module_identities_id_tenant_venue_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "content_module_identities_id_tenant_venue_kind_key" UNIQUE ("id", "tenant_id", "venue_id", "kind")
);

CREATE TABLE "content_module_revisions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL,
  "version" INTEGER NOT NULL,
  "audience" "NormalizedContentAudience" NOT NULL,
  "effective_from" TIMESTAMP(3),
  "effective_until" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_module_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_module_revisions_version_check" CHECK ("version" > 0),
  CONSTRAINT "content_module_revisions_effective_check" CHECK ("effective_until" IS NULL OR "effective_from" IS NULL OR "effective_until" > "effective_from"),
  CONSTRAINT "content_module_revisions_module_version_key" UNIQUE ("module_id", "tenant_id", "venue_id", "version"),
  CONSTRAINT "content_module_revisions_scope_kind_key" UNIQUE ("id", "tenant_id", "venue_id", "kind")
);

CREATE TABLE "service_content" (
  "revision_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'SERVICE',
  "name" VARCHAR(200) NOT NULL, "description" VARCHAR(10000), "availability" VARCHAR(2000), "place_id" TEXT,
  CONSTRAINT "service_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "service_content_kind_check" CHECK ("kind" = 'SERVICE'),
  CONSTRAINT "service_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);
CREATE TABLE "policy_content" (
  "revision_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'POLICY',
  "title" VARCHAR(200) NOT NULL, "rule" VARCHAR(20000) NOT NULL, "applies_to" TEXT[] NOT NULL,
  CONSTRAINT "policy_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "policy_content_kind_check" CHECK ("kind" = 'POLICY'),
  CONSTRAINT "policy_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);
CREATE TABLE "event_content" (
  "revision_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'EVENT',
  "name" VARCHAR(200) NOT NULL, "description" VARCHAR(10000), "starts_at" TIMESTAMP(3) NOT NULL, "ends_at" TIMESTAMP(3), "place_id" TEXT,
  CONSTRAINT "event_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "event_content_kind_check" CHECK ("kind" = 'EVENT'),
  CONSTRAINT "event_content_dates_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "event_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);
CREATE TABLE "operational_fact_content" (
  "revision_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'OPERATIONAL_FACT',
  "label" VARCHAR(200) NOT NULL, "value" VARCHAR(5000) NOT NULL, "expires_at" TIMESTAMP(3),
  CONSTRAINT "operational_fact_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "operational_fact_content_kind_check" CHECK ("kind" = 'OPERATIONAL_FACT'),
  CONSTRAINT "operational_fact_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);
CREATE TABLE "relationship_content" (
  "revision_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'RELATIONSHIP',
  "from_module_id" TEXT NOT NULL, "to_module_id" TEXT NOT NULL,
  "relationship_type" VARCHAR(100) NOT NULL, "description" VARCHAR(2000),
  CONSTRAINT "relationship_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "relationship_content_kind_check" CHECK ("kind" = 'RELATIONSHIP'),
  CONSTRAINT "relationship_content_distinct_endpoints_check" CHECK ("from_module_id" <> "to_module_id"),
  CONSTRAINT "relationship_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);
CREATE TABLE "content_module_evidence" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL, "module_kind" "NormalizedContentModuleKind" NOT NULL,
  "source_id" VARCHAR(500) NOT NULL, "locator" VARCHAR(2000), "captured_at" TIMESTAMP(3) NOT NULL,
  "excerpt_hash" CHAR(64), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_module_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_module_evidence_hash_check" CHECK ("excerpt_hash" IS NULL OR "excerpt_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "content_module_evidence_source_check" CHECK (char_length(btrim("source_id")) > 0),
  CONSTRAINT "content_module_evidence_revision_source_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "source_id", "locator")
);

ALTER TABLE "content_module_identities" ADD CONSTRAINT "content_module_identities_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_identities" ADD CONSTRAINT "content_module_identities_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_revisions" ADD CONSTRAINT "content_module_revisions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_revisions" ADD CONSTRAINT "content_module_revisions_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_revisions" ADD CONSTRAINT "content_module_revisions_module_scope_fkey" FOREIGN KEY ("module_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_identities"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "service_content" ADD CONSTRAINT "service_content_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "service_content" ADD CONSTRAINT "service_content_place_scope_fkey" FOREIGN KEY ("place_id", "tenant_id", "venue_id") REFERENCES "places"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "policy_content" ADD CONSTRAINT "policy_content_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "event_content" ADD CONSTRAINT "event_content_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "event_content" ADD CONSTRAINT "event_content_place_scope_fkey" FOREIGN KEY ("place_id", "tenant_id", "venue_id") REFERENCES "places"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "operational_fact_content" ADD CONSTRAINT "operational_fact_content_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_from_scope_fkey" FOREIGN KEY ("from_module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_to_scope_fkey" FOREIGN KEY ("to_module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_evidence" ADD CONSTRAINT "content_module_evidence_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_evidence" ADD CONSTRAINT "content_module_evidence_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_evidence" ADD CONSTRAINT "content_module_evidence_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "content_module_identities_scope_kind_idx" ON "content_module_identities"("tenant_id", "venue_id", "kind", "created_at");
CREATE INDEX "content_module_revisions_scope_kind_idx" ON "content_module_revisions"("tenant_id", "venue_id", "kind", "created_at");
CREATE INDEX "service_content_scope_name_idx" ON "service_content"("tenant_id", "venue_id", "name");
CREATE INDEX "policy_content_scope_title_idx" ON "policy_content"("tenant_id", "venue_id", "title");
CREATE INDEX "event_content_scope_starts_idx" ON "event_content"("tenant_id", "venue_id", "starts_at");
CREATE INDEX "operational_fact_content_scope_label_idx" ON "operational_fact_content"("tenant_id", "venue_id", "label");
CREATE INDEX "relationship_content_from_idx" ON "relationship_content"("tenant_id", "venue_id", "from_module_id", "relationship_type");
CREATE INDEX "relationship_content_to_idx" ON "relationship_content"("tenant_id", "venue_id", "to_module_id", "relationship_type");
CREATE INDEX "content_module_evidence_scope_revision_idx" ON "content_module_evidence"("tenant_id", "venue_id", "revision_id", "captured_at");

CREATE FUNCTION pathfinder_reject_content_module_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER content_module_identities_append_only BEFORE UPDATE OR DELETE ON "content_module_identities" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_identities_no_truncate BEFORE TRUNCATE ON "content_module_identities" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_revisions_append_only BEFORE UPDATE OR DELETE ON "content_module_revisions" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_revisions_no_truncate BEFORE TRUNCATE ON "content_module_revisions" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER service_content_append_only BEFORE UPDATE OR DELETE ON "service_content" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER service_content_no_truncate BEFORE TRUNCATE ON "service_content" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER policy_content_append_only BEFORE UPDATE OR DELETE ON "policy_content" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER policy_content_no_truncate BEFORE TRUNCATE ON "policy_content" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER event_content_append_only BEFORE UPDATE OR DELETE ON "event_content" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER event_content_no_truncate BEFORE TRUNCATE ON "event_content" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER operational_fact_content_append_only BEFORE UPDATE OR DELETE ON "operational_fact_content" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER operational_fact_content_no_truncate BEFORE TRUNCATE ON "operational_fact_content" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER relationship_content_append_only BEFORE UPDATE OR DELETE ON "relationship_content" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER relationship_content_no_truncate BEFORE TRUNCATE ON "relationship_content" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_evidence_append_only BEFORE UPDATE OR DELETE ON "content_module_evidence" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_evidence_no_truncate BEFORE TRUNCATE ON "content_module_evidence" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();

COMMIT;
