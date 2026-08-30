BEGIN;

ALTER TABLE "operational_updates" ADD CONSTRAINT "operational_updates_id_scope_key" UNIQUE ("id", "tenant_id", "venue_id");

CREATE TABLE "knowledge_proposal_operational_update_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "proposal_id" UUID NOT NULL,
  "operational_update_id" TEXT NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_proposal_operational_update_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_proposal_update_handoffs_preview_hash_check" CHECK ("preview_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "knowledge_proposal_update_handoffs_proposal_scope_key" UNIQUE ("proposal_id", "tenant_id", "venue_id"),
  CONSTRAINT "knowledge_proposal_update_handoffs_update_scope_key" UNIQUE ("operational_update_id", "tenant_id", "venue_id")
);

ALTER TABLE "knowledge_proposal_operational_update_handoffs" ADD CONSTRAINT "knowledge_proposal_update_handoffs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_proposal_operational_update_handoffs" ADD CONSTRAINT "knowledge_proposal_update_handoffs_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_proposal_operational_update_handoffs" ADD CONSTRAINT "knowledge_proposal_update_handoffs_proposal_scope_fkey" FOREIGN KEY ("proposal_id", "tenant_id", "venue_id") REFERENCES "knowledge_change_proposals"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "knowledge_proposal_operational_update_handoffs" ADD CONSTRAINT "knowledge_proposal_update_handoffs_update_scope_fkey" FOREIGN KEY ("operational_update_id", "tenant_id", "venue_id") REFERENCES "operational_updates"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "knowledge_proposal_update_handoffs_scope_created_idx" ON "knowledge_proposal_operational_update_handoffs"("tenant_id", "venue_id", "created_at");

CREATE FUNCTION pathfinder_reject_knowledge_proposal_update_handoff_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER knowledge_proposal_update_handoffs_append_only BEFORE UPDATE OR DELETE ON "knowledge_proposal_operational_update_handoffs" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_knowledge_proposal_update_handoff_mutation();
CREATE TRIGGER knowledge_proposal_update_handoffs_no_truncate BEFORE TRUNCATE ON "knowledge_proposal_operational_update_handoffs" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_knowledge_proposal_update_handoff_mutation();

COMMIT;
