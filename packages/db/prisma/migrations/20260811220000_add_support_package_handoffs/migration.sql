BEGIN;

CREATE TABLE "support_package_handoffs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "venue_package_id" TEXT NOT NULL,
  "request_version" INTEGER NOT NULL,
  "linked_by_kind" "SupportParticipantKind" NOT NULL DEFAULT 'OPERATOR',
  "linked_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_package_handoffs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "support_package_handoffs_id_tenant_id_venue_id_key" ON "support_package_handoffs"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "support_package_handoffs_request_package_scope_key" ON "support_package_handoffs"("support_request_id", "venue_package_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "support_package_handoffs_package_scope_key" ON "support_package_handoffs"("venue_package_id", "tenant_id", "venue_id");
CREATE INDEX "support_package_handoffs_request_created_idx" ON "support_package_handoffs"("tenant_id", "venue_id", "support_request_id", "created_at", "id");

ALTER TABLE "support_package_handoffs" ADD CONSTRAINT "support_package_handoffs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoffs" ADD CONSTRAINT "support_package_handoffs_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoffs" ADD CONSTRAINT "support_package_handoffs_request_scope_fkey" FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoffs" ADD CONSTRAINT "support_package_handoffs_package_scope_fkey" FOREIGN KEY ("venue_package_id", "tenant_id", "venue_id") REFERENCES "venue_packages"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_support_package_handoff_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER support_package_handoffs_append_only BEFORE UPDATE OR DELETE ON "support_package_handoffs" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_package_handoff_mutation();
CREATE TRIGGER support_package_handoffs_no_truncate BEFORE TRUNCATE ON "support_package_handoffs" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_package_handoff_mutation();

COMMIT;
