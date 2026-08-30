BEGIN;

CREATE TABLE "support_package_handoff_supersessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "superseded_handoff_id" TEXT NOT NULL,
  "replacement_handoff_id" TEXT NOT NULL,
  "request_version" INTEGER NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "created_by_kind" "SupportParticipantKind" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_package_handoff_supersessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_handoff_supersessions_distinct_handoffs_check" CHECK ("superseded_handoff_id" <> "replacement_handoff_id")
);

CREATE UNIQUE INDEX "support_handoff_supersessions_tenant_operation_key" ON "support_package_handoff_supersessions"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "support_handoff_supersessions_prior_scope_key" ON "support_package_handoff_supersessions"("superseded_handoff_id", "tenant_id", "venue_id");
CREATE INDEX "support_handoff_supersessions_replacement_scope_idx" ON "support_package_handoff_supersessions"("replacement_handoff_id", "tenant_id", "venue_id");
CREATE INDEX "support_handoff_supersessions_request_created_idx" ON "support_package_handoff_supersessions"("tenant_id", "venue_id", "support_request_id", "created_at", "id");

ALTER TABLE "support_package_handoff_supersessions" ADD CONSTRAINT "support_handoff_supersessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoff_supersessions" ADD CONSTRAINT "support_handoff_supersessions_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoff_supersessions" ADD CONSTRAINT "support_handoff_supersessions_request_scope_fkey" FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoff_supersessions" ADD CONSTRAINT "support_handoff_supersessions_prior_scope_fkey" FOREIGN KEY ("superseded_handoff_id", "tenant_id", "venue_id") REFERENCES "support_package_handoffs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_package_handoff_supersessions" ADD CONSTRAINT "support_handoff_supersessions_replacement_scope_fkey" FOREIGN KEY ("replacement_handoff_id", "tenant_id", "venue_id") REFERENCES "support_package_handoffs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_support_handoff_supersession_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER support_handoff_supersessions_append_only BEFORE UPDATE OR DELETE ON "support_package_handoff_supersessions" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_handoff_supersession_mutation();
CREATE TRIGGER support_handoff_supersessions_no_truncate BEFORE TRUNCATE ON "support_package_handoff_supersessions" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_handoff_supersession_mutation();

-- Admit only the founder-gated capability that reconciles one reverted support
-- handoff to one separately applied replacement handoff. It has no package,
-- support-status, customer-contact, or external-delivery authority.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-improvements:validate','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','intake:draft','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:apply','packages:approve','packages:draft','packages:read','packages:reconcile','packages:revert','questions:ask','questions:read','readiness:read','reports:draft','reports:read','resources:read','support:complete','support:draft','support:note','support:open','support:read','support:request-information','support:triage','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
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
