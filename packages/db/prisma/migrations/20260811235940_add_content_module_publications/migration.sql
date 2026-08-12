BEGIN;

CREATE TYPE "ContentModulePublicationAction" AS ENUM ('PUBLISH', 'WITHDRAW');

CREATE TABLE "content_module_publications" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "module_kind" "NormalizedContentModuleKind" NOT NULL,
  "action" "ContentModulePublicationAction" NOT NULL,
  "event_order" BIGSERIAL NOT NULL,
  "request_id" UUID NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_module_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_module_publications_event_order_key" UNIQUE ("event_order"),
  CONSTRAINT "content_module_publications_tenant_request_key" UNIQUE ("tenant_id", "request_id")
);

ALTER TABLE "content_module_publications" ADD CONSTRAINT "content_module_publications_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_publications" ADD CONSTRAINT "content_module_publications_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_publications" ADD CONSTRAINT "content_module_publications_module_scope_fkey"
  FOREIGN KEY ("module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_module_revisions" ADD CONSTRAINT "content_module_revisions_scope_module_kind_key"
  UNIQUE ("id", "tenant_id", "venue_id", "module_id", "kind");
ALTER TABLE "content_module_publications" ADD CONSTRAINT "content_module_publications_revision_scope_fkey"
  FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_id", "module_kind") REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "module_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "content_module_publications_scope_module_order_idx"
  ON "content_module_publications"("tenant_id", "venue_id", "module_id", "event_order");

CREATE TRIGGER content_module_publications_append_only
BEFORE UPDATE OR DELETE ON "content_module_publications"
FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_content_module_mutation();
CREATE TRIGGER content_module_publications_no_truncate
BEFORE TRUNCATE ON "content_module_publications"
FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_content_module_mutation();

COMMIT;
